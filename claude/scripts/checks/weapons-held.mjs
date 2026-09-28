/**
 * `weapons-held` — T23.16: every firearm is F6's model, in the hand, on the ground and in the bag.
 *
 * ## 1. Level A on F6's weapon boxes (gating)
 *
 * The look-lab's F6 (the arsenal: 21 weapons alone at ~4.5×, the platform gun's turret, and the 1× row of figures
 * holding each) at the full tier against the mockup's F6 with only what the lab does not draw taken out
 * (`reference/controls/weaponsonly.js` → `F6-weapons.png`: no text, no weapon effects — T23.18), in the reference
 * harness's browser (`actor-atlas` §1 says why). **Gates:** the union of the 22 grid boxes (the weapons and the
 * turret) within this back end's actor threshold (R25, T23.12), and **each** grid box within `PER_BOX` — the
 * union alone cannot see one weapon wrong among 22. Must fail: `&knob=actor-rim-off` on both.
 * **The 1× row is reported, not gated:** its figures are `e_style.js::stick`s, which the game does not draw (it draws
 * `poses.js`'s figure, `stick-figure`'s F7), and at 1× a 30-px box is mostly edge — measured 0.387 over the row
 * where the grid is 0.168; baking the row whole (the mockup's own canvas composite) still left 0.25, so it is
 * anti-aliasing at a sub-pixel phase, not the drawing. The hand is gated live instead (§3).
 *
 * ## 2. Readability: no two firearms' silhouettes too alike at game scale
 *
 * Each firearm's ink mask (alpha > ½) drawn by its model at the figure's scale (1.15, aim 0, one origin), zoom 1;
 * IoU of every pair. The most similar pair is stated; the gate is `IOU_MAX`, picked from the data (below).
 *
 * ## 3. Live: selecting each firearm changes the hand, and nothing else (the sandbox, the game's renderer)
 *
 * Each firearm given (`__game.giveItem`) and selected through the inventory, the scene frozen still, the world
 * canvas read: the **hand patch** (shoulder to muzzle) changes from the previous weapon's by `HAND_MIN`; the **legs**
 * (the control region) do not change at all; and the figure handed to the renderer holds that weapon (both ends).
 *
 * ## 4. The pickup is the same drawing (R12)
 *
 * Each firearm staged as a pickup through the match's item layer: the layer draws the weapon's icon texture
 * (`weapon_<key>`, `look/actors/icons.ts`) at its fitted world size, and the page shows it (pixels at the pickup
 * against no pickup).
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { actorBoxes, boxesDeltaE, loadPng, thresholdsFor } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { chromePath, libDir } from '../lib/browser-args.mjs'
import { REFERENCE_ARGS } from './actor-atlas.mjs'
import { decode, freezeStill, rectDelta } from './figure-frames.mjs'
import { patchRGBA, toScreen } from './pixels.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'client/package.json'))
const { chromium } = require('playwright-core')
const { PNG } = require('pngjs')
const RAW = JSON.parse((await import('node:fs')).readFileSync(join(root, 'scripts/lib/look-thresholds.json'), 'utf8'))

/** F6's cast: 21 weapons + the turret (the grid), then the 1× row: 21 figures + the turret (`scenes.test.ts`). */
const F6_ACTORS = 44
const GRID = 22
/**
 * One grid box's own gate (mean ΔE2000). Measured 2026-09-28 (SwiftShader): the lab's worst matching box is 0.578
 * (the toxic grenade: 19 × 34 px, its green rim's edge pixels flip — no visible difference, looked at 12×), and the
 * smallest a box moves under `actor-rim-off` is 1.296 (the molotov, whose flame the knob leaves). Their midpoint.
 */
const PER_BOX = 0.937
/**
 * §2's gate: no two firearms' silhouettes may overlap more than this (IoU). From the data (2026-09-28, 1.15, zoom 1):
 * the most similar firearms are laser_pistol / pistol at 0.679; the collision the milestone names as the likely one
 * (`T23.17`: axe / hammer) is 0.760. The gate is their midpoint: two guns may not be as alike as axe and hammer.
 */
const IOU_MAX = 0.72
/**
 * §3: pixels of the hand patch that must change (Σ|Δ| over RGB > `PX_MOVED`) between two firearms. Counted, not
 * averaged: at 1× the pistol and the revolver differ in a dozen pixels of a 60 × 25 patch, which a mean dilutes.
 */
const HAND_PX = 6
const PX_MOVED = 30
/** §3: the legs (the control region) may change by no more than this mean |Δ| per channel (as `boots-visible`'s head). */
const LEGS_MAX = 0.5
/** §4: mean |Δ| per channel the page must change by at the pickup, against no pickup (levels). */
const PICKUP_MIN = 3

const FIREARMS = ['bazooka', 'smg', 'laser_pistol', 'laser_smg', 'pistol', 'revolver', 'deagle', 'machinegun', 'flamethrower']

async function lab(page, origin, extra) {
  await page.goto(`${origin}/?look=F6&e2e=1${extra}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => JSON.parse(JSON.stringify(window.__look)))
  if (look.error) throw new Error(`look-lab F6${extra}: ${look.error}`)
  const f = decode(await page.evaluate(() => window.__world.readFrame()))
  return { look, frame: f, info: await page.evaluate(() => window.__world.info()), actors: await page.evaluate(() => window.__world.actors()) }
}

export default async function ({ page, shot, log }) {
  const origin = new URL(page.url()).origin
  const problems = []
  const firearms = await page.evaluate(async () => [...(await import('/src/look/actors/weapons.ts')).FIREARMS])
  if (JSON.stringify(firearms) !== JSON.stringify(FIREARMS)) problems.push(`the model's firearms ${JSON.stringify(firearms)} are not this check's ${JSON.stringify(FIREARMS)}`)

  // ------------------------------------------------------------ 1. Level A on the arsenal
  const boxes = actorBoxes('F6')
  const reference = loadPng(join(root, 'tasks/M23/reference/controls/F6-weapons.png'))
  const browser = await chromium.launch({ executablePath: chromePath, env: { ...process.env, LD_LIBRARY_PATH: libDir }, headless: true, args: REFERENCE_ARGS })
  try {
    const own = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    await own.goto(`${origin}/?e2e=1`, { waitUntil: 'load' })
    await own.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
    const on = await lab(own, origin, '')
    const TH = thresholdsFor(RAW, on.info.gpu)
    const T = TH.actors
    if (TH.backEnd !== 'swiftshader') throw new Error(`F6's reference is SwiftShader's; the ${TH.backEnd} set has no F6 reference yet`)
    if (on.look.described.actors !== F6_ACTORS || on.actors.quads !== F6_ACTORS) problems.push(`counted: described ${on.look.described.actors}, quads ${on.actors.quads}, want ${F6_ACTORS}`)
    if (boxes.length !== F6_ACTORS) problems.push(`actor-boxes.json has ${boxes.length} F6 boxes, want ${F6_ACTORS}`)
    const grid = boxes.slice(0, GRID)
    const d = boxesDeltaE(on.frame, reference, grid)
    log(`1. look-lab F6 vs F6-weapons.png on the ${GRID} grid boxes: deltaE_actors ${d.toFixed(4)} (max ${T.threshold}) ${d <= T.threshold ? 'ok' : 'FAIL'}`)
    if (d > T.threshold) problems.push(`Level A: grid deltaE_actors ${d.toFixed(4)} > ${T.threshold}`)
    const keys = await own.evaluate(async () => (await import('/src/look/scenes/F6.ts')).F6.actors.map((a) => a.opts.key ?? a.kind))
    for (const [k, b] of grid.entries()) {
      const e = boxesDeltaE(on.frame, reference, [b])
      log(`   box ${String(k).padStart(2)} ${String(keys[k] ?? '').padEnd(14)} ${JSON.stringify(b).padEnd(22)} ${e.toFixed(3)}${e > PER_BOX ? '  FAIL' : ''}`)
      if (e > PER_BOX) problems.push(`Level A: grid box ${k} ${JSON.stringify(b)} ${e.toFixed(3)} > ${PER_BOX}`)
    }
    const row = boxesDeltaE(on.frame, reference, boxes.slice(GRID))
    log(`1. (reported, not gated) the 1× row's ${F6_ACTORS - GRID} boxes: ${row.toFixed(4)}`)
    const off = await lab(own, origin, '&knob=actor-rim-off')
    const dOff = boxesDeltaE(off.frame, reference, grid)
    const boxOff = Math.min(...grid.map((b) => boxesDeltaE(off.frame, reference, [b])))
    log(`1. control knob=actor-rim-off: grid ${dOff.toFixed(4)}, smallest box ${boxOff.toFixed(3)} — ${dOff > T.threshold && boxOff > PER_BOX ? 'fails, as it must' : 'PASSES — the check cannot see the rim'}`)
    if (!(dOff > T.threshold)) problems.push(`control actor-rim-off passed the grid (${dOff.toFixed(4)})`)
    if (!(boxOff > PER_BOX)) problems.push(`control actor-rim-off passed a box (${boxOff.toFixed(3)})`)
    const out = new PNG({ width: 1280, height: 720 * 2 + 8 })
    out.data.fill(255)
    Buffer.from(on.frame.data.buffer, on.frame.data.byteOffset, 1280 * 720 * 4).copy(out.data, 0)
    Buffer.from(reference.data.buffer, reference.data.byteOffset, 1280 * 720 * 4).copy(out.data, 1280 * 728 * 4)
    writeFileSync(join(root, 'shots/weapons-held-F6-lab-vs-mockup.png'), PNG.sync.write(out))
  } finally {
    await browser.close()
  }

  // ------------------------------------------------------------ 2. readability
  const r = await page.evaluate(async (keys) => {
    const W = await import('/src/look/actors/weapons.ts')
    const S = 1.15
    const N = 80
    const mask = (k) => {
      const c = document.createElement('canvas')
      c.width = N
      c.height = N
      const g = c.getContext('2d')
      g.lineCap = 'round'
      g.lineJoin = 'round'
      W.drawWeapon(g, k, 20, N / 2, S, '#e8482c')
      const d = g.getImageData(0, 0, N, N).data
      const m = new Uint8Array(N * N)
      for (let i = 0; i < N * N; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0
      return m
    }
    const M = keys.map(mask)
    const px = M.map((m) => m.reduce((a, b) => a + b, 0))
    const pairs = []
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        let n = 0
        let u = 0
        for (let p = 0; p < N * N; p++) {
          n += M[i][p] & M[j][p]
          u += M[i][p] | M[j][p]
        }
        pairs.push([keys[i], keys[j], u ? n / u : 1])
      }
    }
    return { px, pairs: pairs.sort((a, b) => b[2] - a[2]) }
  }, FIREARMS)
  log(`2. ink px at 1×: ${FIREARMS.map((k, i) => `${k} ${r.px[i]}`).join(', ')}`)
  log(`2. most similar firearm pairs (IoU): ${r.pairs.slice(0, 4).map(([a, b, v]) => `${a}/${b} ${v.toFixed(3)}`).join(', ')} (max ${IOU_MAX})`)
  if (r.px.some((n) => n < 10)) problems.push(`a firearm draws under 10 px at 1×: ${JSON.stringify(r.px)}`)
  const [a0, b0, v0] = r.pairs[0]
  if (v0 > IOU_MAX) problems.push(`${a0} and ${b0} are too alike at game scale: IoU ${v0.toFixed(3)} > ${IOU_MAX}`)

  // ------------------------------------------------------------ 3. live: the hand changes with the weapon
  // The sandbox bag has four quick slots free after its own loadout (shovel, bazooka, grenade, smg); the backpack
  // cannot be selected (§C10), so the rest come in a second visit.
  const batches = [
    ['bazooka', 'smg', 'laser_pistol', 'laser_smg', 'pistol', 'revolver'],
    ['deagle', 'machinegun', 'flamethrower', 'bazooka'],
  ]
  let prev = null
  const lineup = []
  for (const [bi, batch] of batches.entries()) {
    if (bi > 0) {
      await page.reload({ waitUntil: 'load' })
      prev = null
    }
    await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
    for (const key of batch) {
      const slot = await page.evaluate((k) => {
        const inv = window.__game.inventory()
        const have = inv?.slots.findIndex((s) => s && s.key === k) ?? -1
        return have >= 0 ? have : window.__game.giveItem(k)
      }, key)
      const quick = (await page.evaluate(() => window.__game.constants())).QUICK_SLOTS
      if (!(slot >= 0 && slot < quick)) {
        problems.push(`${key}: landed in slot ${slot}, not a quick slot`)
        continue
      }
      await page.evaluate((s) => window.__game.selectSlot(s), slot)
      const d = await freezeStill(page)
      const a = d.figure
      if (a.opts.J.weapon !== key) problems.push(`${key} selected, and the figure handed to the renderer holds ${a.opts.J.weapon}`)
      const f = decode(await page.evaluate(() => window.__world.readFrame()))
      const s = a.opts.s
      const face = a.opts.face ?? 1
      const hand = face > 0 ? [a.x - 12 * s, a.y - 34 * s, a.x + 40 * s, a.y - 12 * s] : [a.x - 40 * s, a.y - 34 * s, a.x + 12 * s, a.y - 12 * s]
      const legs = [a.x - 9 * s, a.y - 11 * s, a.x + 9 * s, a.y + 1 * s]
      // The control frame: the same weapon read again after a beat — the patch count a frame changes by on its own.
      await page.waitForTimeout(150)
      const again = decode(await page.evaluate(() => window.__world.readFrame()))
      const still = movedPx(f, again, hand)
      if (still !== 0) problems.push(`${key}: the frozen frame changed by itself (${still} hand px)`)
      if (prev) {
        const n = movedPx(f, prev.f, hand)
        const h = rectDelta(f, prev.f, hand)
        const l = rectDelta(f, prev.f, legs)
        log(`3. ${prev.key} → ${key}: hand ${n} px moved (mean ${h.mean.toFixed(2)}; min ${HAND_PX} px; control, the same frame again: ${still}), legs ${l.mean.toFixed(3)} (max ${LEGS_MAX})`)
        if (!(n >= HAND_PX)) problems.push(`${prev.key} → ${key}: only ${n} hand px moved`)
        if (!(l.mean <= LEGS_MAX)) problems.push(`${prev.key} → ${key}: the legs changed by ${l.mean.toFixed(3)} — the frame moved`)
      }
      if (!lineup.some((x) => x.key === key)) lineup.push({ key, f, a })
      prev = { key, f }
      await page.evaluate(() => window.__game.freeze(false))
    }
  }
  if (lineup.length !== FIREARMS.length) problems.push(`the live leg held ${lineup.length} of ${FIREARMS.length} firearms`)
  writeFileSync(join(root, 'shots/weapons-held-live.png'), PNG.sync.write(strip(lineup)))

  // ------------------------------------------------------------ 4. the pickup is the icon
  await page.waitForFunction(() => window.__game && window.__world, null, { timeout: 60_000 })
  const { x: px0, y: py0 } = (await page.evaluate(() => window.__game.debug())).player
  const at = [px0 + 60, py0 - 12]
  const scr = await toScreen(page, ...at)
  if (!scr?.onScreen) problems.push(`the pickup spot ${JSON.stringify(at)} is off screen`)
  for (const key of FIREARMS) {
    await page.evaluate(() => window.__game.stagePickup(null))
    const clip = scr && { x: Math.round(scr.x - 16 * scr.scale), y: Math.round(scr.y - 10 * scr.scale), w: Math.round(32 * scr.scale), h: Math.round(20 * scr.scale) }
    const none = clip ? (await patchRGBA(page, clip)).rgba : null
    const got = await page.evaluate(([x, y, k]) => window.__game.stagePickup(x, y, k), [...at, key])
    await page.waitForTimeout(100)
    const drawn = got.items
    const art = drawn?.[0]?.art ?? null
    if (art !== `weapon_${key}`) problems.push(`${key}: the pickup drew ${JSON.stringify(art)}, not the icon weapon_${key}`)
    let moved = null
    if (clip && none) {
      const withIt = (await patchRGBA(page, clip)).rgba
      moved = meanDelta(none, withIt)
      if (!(moved >= PICKUP_MIN)) problems.push(`${key}: the pickup changes the page by only ${moved.toFixed(2)}`)
    }
    log(`4. ${key}: staged ${got.staged}, drawn ${JSON.stringify(drawn?.[0] ?? null)}${moved === null ? '' : `, page Δ ${moved.toFixed(2)} (min ${PICKUP_MIN})`}`)
  }
  await page.evaluate(() => window.__game.stagePickup(null))
  await shot('weapons-held-end')
  if (problems.length) throw new Error(`weapons-held: ${problems.join('; ')}`)
}

/** Pixels of `a` and `b` (decoded frames) in mask rect [x0, y0, x1, y1] whose RGB differ by more than `PX_MOVED` in sum. */
function movedPx(a, b, [x0, y0, x1, y1]) {
  const k = a.width / a.view.w
  let n = 0
  for (let y = 0; y < a.height; y++) {
    const my = a.view.y + (y + 0.5) / k
    if (my < y0 || my >= y1) continue
    for (let x = 0; x < a.width; x++) {
      const mx = a.view.x + (x + 0.5) / k
      if (mx < x0 || mx >= x1) continue
      const o = (y * a.width + x) * 4
      let s = 0
      for (let c = 0; c < 3; c++) s += Math.abs(a.data[o + c] - b.data[o + c])
      if (s > PX_MOVED) n++
    }
  }
  return n
}

function meanDelta(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) s += Math.abs(a[i + c] - b[i + c])
  return s / ((a.length / 4) * 3)
}

/** The live frames' figures side by side, 3×: each firearm in the hand, as the game drew it. */
function strip(list) {
  const Z = 3
  const W = 70
  const H = 50
  const out = new PNG({ width: W * Z * list.length, height: H * Z })
  for (const [i, { f, a }] of list.entries()) {
    const k = f.width / f.view.w
    for (let y = 0; y < H * Z; y++) {
      for (let x = 0; x < W * Z; x++) {
        const mx = a.x - W / 2 + x / Z
        const my = a.y - H + 6 + y / Z
        const fx = Math.floor((mx - f.view.x) * k)
        const fy = Math.floor((my - f.view.y) * k)
        const o = (y * out.width + i * W * Z + x) * 4
        if (fx < 0 || fy < 0 || fx >= f.width || fy >= f.height) continue
        const q = (fy * f.width + fx) * 4
        for (let c = 0; c < 3; c++) out.data[o + c] = f.data[q + c]
        out.data[o + 3] = 255
      }
    }
  }
  return out
}
