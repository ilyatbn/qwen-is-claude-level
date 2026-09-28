#!/usr/bin/env node
/**
 * `look-match` — T23.08C F9: what T23.08 switched on in the look-lab is on **in a live match** (GameScene,
 * a real server, `map_init` off the wire), and the rock differs from match to match.
 *
 * The look checks (`look-gate-f1`, `look-terrain`, `look-sky`) photograph the lab and the sandbox; nothing
 * photographed a networked match, so a scene that forgot to hand the world renderer its fog or grade — or a
 * `map_init` whose seed never reached the albedo — would pass all of them.
 *
 * ## 1. Fog and grade are drawn (pixels, not flags)
 *
 * One world-canvas frame (`__world.readFrame`), then the same frame with a layer hidden (`hideLayers`):
 * - **fog**: hiding `fogBack` + `fogFront` moves the **band patch** — the `FOG_BAND_ROWS`-row stripe of the
 *   frame's lower half where the two frames differ most — by a mean ≥ `FOG_MIN_DELTA`; the **control patch**
 *   (the top `CONTROL_ROWS` rows: above the fog's ramp, whose quad does not reach there) moves by exactly 0.
 * - **grade**: hiding it moves the whole frame by a mean ≥ `GRADE_MIN_DELTA` (the vignette is strongest at
 *   the edges: the centre alone moved 1.72); control: hiding `fg`
 *   (no foreground leaves in the game — T23.08B) moves no px at all, so a hide that changes pixels is the
 *   layer's, not the harness redrawing.
 * `__world.atmosphere()`'s flags are printed beside the pixels, not trusted instead of them.
 *
 * ## 2. Two matches, two rocks
 *
 * Two servers, `FIXED_SEED` `SEED_A` and `SEED_B`, one client each. A `RECT`² world rect that is deep rock
 * on **both** maps (every px ≥ 64 px inside the rock: the fields' `dIn` byte saturated — so soil, grass,
 * scorch and wall cannot reach it and the lighting inputs are identical) is put under each camera at the
 * same place; its rendered px must differ on ≥ `MIN_DIFFER` of them (R24's per-map albedo offset).
 * Controls: the same match photographed twice is identical there (the difference is the seed's, not
 * animation or grain), and the rect is rock (hiding the terrain moves ≥ `ROCK_SHARE` of its px).
 */
import { startStack, enterBattle, standStill, tally, freePort, drawnFrames } from './harness.mjs'

const { fail, ok, finish } = tally('look-match')

/** The two maps: terrain-seed's pair (V2 Medium; a deep-rock rect in both is known to exist there). */
const SEED_A = 4242
const SEED_B = 7
/** Deep-rock rect side, world px (terrain-seed's). */
const RECT = 64
/** Of the rect's px, at least this share must differ between the two matches (terrain-seed's floor). */
const MIN_DIFFER = 0.5
/** Hiding the terrain must move at least this share of the rect's px (look-terrain's `SWAP_ROCK`). */
const ROCK_SHARE = 0.9
/** A px has moved when a channel changes by more than this (look-terrain's `PIXEL_MOVED`). */
const PIXEL_MOVED = 2
/** Rows of the fog's band patch and of the control patch, buffer px. */
const FOG_BAND_ROWS = 16
const CONTROL_ROWS = 16
/**
 * Mean |Δ| per channel the fog must move its band patch by, and the grade the whole frame. Measured on
 * this check's first runs (low tier, SwiftShader, seed 4242): fog 19.14 (band rows 340–356, max 38), grade 3.42 over
 * the frame (max 79). Set at one level: above the controls' exact 0, and a third of the smaller measured value — a
 * check of presence, not of amount (Level A in `look-gate-f1` is the amount). Planted (fog null in the game's
 * look, `worldRenderer.ts::gameDescription`): red.
 */
const FOG_MIN_DELTA = 1
const GRADE_MIN_DELTA = 1

const decode = (f) => ({ w: f.w, h: f.h, view: f.view, data: Buffer.from(f.rgba, 'base64') })
const frame = async (page) => {
  await drawnFrames(page, 3)
  return decode(await page.evaluate(() => window.__world.readFrame()))
}
const hide = async (page, layers) => {
  await page.evaluate((l) => window.__world.hideLayers(l), layers)
  return frame(page)
}
/** Mean |Δ| per channel over rows [y0, y1) and columns [x0, x1) of two same-size frames; and the max. */
function patch(a, b, [x0, y0, x1, y1]) {
  let s = 0
  let n = 0
  let max = 0
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[(y * a.w + x) * 4 + c] - b.data[(y * a.w + x) * 4 + c])
        s += d
        n++
        max = Math.max(max, d)
      }
  return { mean: s / n, max }
}

async function openMatch(seed) {
  const stack = await startStack({
    port: await freePort(),
    label: `look-match ${seed}`,
    env: { MAP_SCALE: 'medium', ROUND_SECONDS: '300', BOT_COUNT: '0', FIXED_SEED: String(seed), WEATHER: 'off' },
  })
  const { page, pageErrors } = await stack.openClient({ name: `m${seed}` })
  await enterBattle(page, { waitPlaying: true, label: `look-match ${seed}` })
  await page.waitForFunction(() => window.__game.debug().terrainReady && !!window.__world, null, { timeout: 120_000 })
  await standStill(page)
  const d = await page.evaluate(() => {
    const g = window.__game.debug()
    return { warning: g.terrainWarning, info: window.__world.info(), atmos: window.__world.atmosphere(), terrain: window.__world.terrain() }
  })
  return { stack, page, pageErrors, ...d }
}

/** The `RECT`² cells whose every px is deep rock (`dIn` byte 255) in this match's fields. */
const deepCells = (page) =>
  page.evaluate((n) => {
    const c = window.__game.core
    const w = c.width
    const h = c.height
    const f = c.renderFieldsView()
    const out = []
    for (let cy = 0; cy + n <= h; cy += n)
      for (let cx = 0; cx + n <= w; cx += n) {
        let deep = true
        for (let y = cy; y < cy + n && deep; y++) for (let x = cx; x < cx + n && deep; x++) deep = f[(y * w + x) * 4] === 255
        if (deep) out.push(`${cx},${cy}`)
      }
    return out
  }, RECT)

/** The rect's px of a frame (buffer px whose centre maps into the world rect), in one array. */
function rectPx(f, [x, y]) {
  const k = f.w / f.view.w
  const out = []
  for (let by = 0; by < f.h; by++)
    for (let bx = 0; bx < f.w; bx++) {
      const wx = f.view.x + (bx + 0.5) / k
      const wy = f.view.y + (by + 0.5) / k
      if (wx >= x && wx < x + RECT && wy >= y && wy < y + RECT) out.push(f.data.subarray((by * f.w + bx) * 4, (by * f.w + bx) * 4 + 3))
    }
  return out
}
const moved = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > PIXEL_MOVED

const A = await openMatch(SEED_A)
let B = null
try {
  // ------------------------------------------------------------ 1. fog and grade, in pixels
  const pa = A.page
  console.log(`  match ${SEED_A}: renderer ${A.info.gpu}, tier ${A.info.tier} ${A.info.buffer.join('x')}; atmosphere ${JSON.stringify({ ...A.atmos, occluders: undefined, bloomTarget: undefined })}`)
  if (A.warning === '') ok(`seed ${SEED_A}: the terrain fields came from the worker (no warning)`)
  else fail(`seed ${SEED_A}: the terrain fields warn — got ${JSON.stringify(A.warning)}, want ""`)
  const on = await frame(pa)
  const noFog = await hide(pa, ['fogBack', 'fogFront'])
  const noGrade = await hide(pa, ['grade'])
  const noFg = await hide(pa, ['fg'])
  await showAll(pa)
  const W = on.w
  const H = on.h
  let band = { mean: -1 }
  let bandY = -1
  for (let y = Math.floor(H / 2); y + FOG_BAND_ROWS <= H; y += FOG_BAND_ROWS / 2) {
    const p = patch(on, noFog, [0, y, W, y + FOG_BAND_ROWS])
    if (p.mean > band.mean) {
      band = p
      bandY = y
    }
  }
  const top = patch(on, noFog, [0, 0, W, CONTROL_ROWS])
  console.log(`  fog: band patch rows ${bandY}..${bandY + FOG_BAND_ROWS} mean |Δ| ${band.mean.toFixed(2)} (max ${band.max}) with fog hidden; control, top ${CONTROL_ROWS} rows: mean ${top.mean.toFixed(3)}, max ${top.max}`)
  if (top.max !== 0) fail(`control: hiding the fog moved the top rows (max ${top.max}) — the fog's quad reaches above its ramp, or the frame is not static`)
  if (band.mean >= FOG_MIN_DELTA) ok(`the fog is drawn in the match: hiding it moves its band by ${band.mean.toFixed(2)} (min ${FOG_MIN_DELTA})`)
  else fail(`the fog is not drawn in the match: hiding it moves its band by ${band.mean.toFixed(2)} (min ${FOG_MIN_DELTA})`)
  const grade = patch(on, noGrade, [0, 0, W, H])
  const fg = patch(on, noFg, [0, 0, W, H])
  console.log(`  grade: whole frame mean |Δ| ${grade.mean.toFixed(2)} (max ${grade.max}) with the grade hidden; control, fg hidden (no leaves in the game): mean ${fg.mean.toFixed(3)}, max ${fg.max}`)
  // T23.10: judged on the mean, a twentieth of the grade's floor — not "no px at all": at zoom 1 the view holds four
  // times the map, and something animated in it (a bird's wing, a fire) moves a few px between any two frames (seen:
  // mean 0.002, max 86–94, against the grade's 5.02). The top-rows fog control above stays exact.
  if (fg.mean > GRADE_MIN_DELTA / 20) fail(`control: hiding the absent foreground moved the frame (mean ${fg.mean.toFixed(3)}, max ${fg.max}) — hides are not what moves the frame`)
  if (grade.mean >= GRADE_MIN_DELTA) ok(`the grade is drawn in the match: hiding it moves the frame by ${grade.mean.toFixed(2)} (min ${GRADE_MIN_DELTA})`)
  else fail(`the grade is not drawn in the match: hiding it moves the frame by ${grade.mean.toFixed(2)} (min ${GRADE_MIN_DELTA})`)

  // ------------------------------------------------------------ 2. two matches, two rocks
  B = await openMatch(SEED_B)
  if (B.warning === '') ok(`seed ${SEED_B}: the terrain fields came from the worker (no warning)`)
  else fail(`seed ${SEED_B}: the terrain fields warn — got ${JSON.stringify(B.warning)}, want ""`)
  const ca = await deepCells(pa)
  const cb = new Set(await deepCells(B.page))
  const both = ca.filter((c) => cb.has(c))
  console.log(`  deep-rock ${RECT}px cells: seed ${SEED_A} ${ca.length}, seed ${SEED_B} ${cb.size}, in both ${both.length}`)
  if (!both.length) throw new Error('no world rect is deep rock on both maps — pick other seeds')
  const at = both[Math.floor(both.length / 2)].split(',').map(Number)
  const look = async (m) => {
    await m.page.evaluate(([x, y]) => window.__game.watch(x, y), [at[0] + RECT / 2, at[1] + RECT / 2])
    const f = await frame(m.page)
    return f
  }
  const fa = await look(A)
  const fb = await look(B)
  const fa2 = await frame(pa)
  await pa.evaluate(() => window.__world.hideTerrain(true))
  const faBare = await frame(pa)
  await pa.evaluate(() => window.__world.hideTerrain(false))
  const [ra, rb, ra2, rBare] = [fa, fb, fa2, faBare].map((f) => rectPx(f, at))
  const n = ra.length
  if (!n || rb.length !== n || JSON.stringify(fa.view) !== JSON.stringify(fb.view)) {
    fail(`the two cameras do not frame the rect alike: ${n} vs ${rb.length} px, views ${JSON.stringify(fa.view)} / ${JSON.stringify(fb.view)}`)
  } else {
    const differ = ra.filter((p, i) => moved(p, rb[i])).length
    const same = ra.filter((p, i) => !moved(p, ra2[i]) && p[0] === ra2[i][0] && p[1] === ra2[i][1] && p[2] === ra2[i][2]).length
    const rock = ra.filter((p, i) => moved(p, rBare[i])).length
    console.log(`  rect (${at[0]}, ${at[1]}) ${RECT}x${RECT} world px = ${n} buffer px: seed ${SEED_A} vs ${SEED_B} ${differ} differ (min ${Math.ceil(MIN_DIFFER * n)}); seed ${SEED_A} twice ${same} identical; rock (moves with the terrain hidden) ${rock}`)
    if (same !== n) fail(`control: seed ${SEED_A} photographed twice differs on ${n - same} px of the rect — the frame is not static`)
    if (rock < ROCK_SHARE * n) fail(`control: only ${rock}/${n} px of the rect are rock (min ${Math.ceil(ROCK_SHARE * n)})`)
    if (differ >= MIN_DIFFER * n) ok(`two matches show different rock at one world rect (${differ}/${n} px)`)
    else fail(`two matches show the same rock at one world rect: only ${differ}/${n} px differ`)
  }
  for (const [m, s] of [[A, SEED_A], [B, SEED_B]]) if (m.pageErrors.length) fail(`seed ${s}: page errors: ${m.pageErrors.slice(0, 3).join(' | ')}`)
} catch (e) {
  fail(String(e?.stack ?? e))
}
await finish(async () => {
  await A.stack.close()
  await B?.stack.close()
})

async function showAll(page) {
  await page.evaluate(() => window.__world.hideLayers([]))
}
