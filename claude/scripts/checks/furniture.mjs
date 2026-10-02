/**
 * `furniture` (T23.19) — the world's furniture in the world renderer, on pixels: pickups (a weapon and an item),
 * their label, a grave **at night against dark rock**, the ground animals, and the stamped crystals with their glow
 * and light. Each is photographed on one frozen frame with and without it (the control frame), beside a patch as far
 * away that must not move (the control region).
 *
 * The grave is the owed item (T23.15: one ink stone disappeared into night rock): at night its box must change and
 * **stand out from the rock round it** — the brightest pixels of its box against the rock's (`GRAVE_LIFT`).
 * The pickups, graves and animals are drawn by the world renderer, not Phaser (`drawsInWorld`), which is what retired
 * T23.19A's stopgap: a figure over one is not covered (`gunner-visible`).
 *
 * T23.19D: **F1** — with no world renderer (`?world=off`, the entry `furniture-world-off`; the same as no WebGL2) the
 * pickups, graves and animals are Phaser's and on screen (they followed `!spaceMap`, not the drawer, and vanished).
 * **F2** — the night halo is a night thing: its ring round the grave lifts the rock at night and not at noon (the
 * night leg is the noon leg's control). **F3** — the pickup's label is Phaser text at screen resolution, outside the
 * world's post chain: its glyph edges keep a contrast floor on the low tier, which the same crop blurred 3×3 (what
 * the half-resolution world canvas did to it) does not.
 *
 * T23.36: graves now glow in their owner's colour by day too (`graves.mjs` checks that); the stones here are staged
 * with `glow: false`, so F2's night halo is what these legs still measure.
 */
import { comparePhotos, photo, toScreen, patchRGBA } from './pixels.mjs'

/** A furniture box counts as drawn when this share of its pixels changes with it hidden. */
const MIN_CHANGED = 0.15
/** The control region's allowance on a frozen frame (measured 0.000 on gunner-visible's). */
const MAX_CONTROL = 0.02
/** The night: `setTime` (s into the cycle) where the sandbox is darkest — read back as `darkness` and asserted. */
const NIGHT_T = 90
/** The grave's brightest pixels (luminance p95 of its box) over the rock's round it, 0–255: the night halo and rim. */
const GRAVE_LIFT = 12
/** Seeds tried for one carrying crystals (the generator stamps them on some maps only). */
const SEEDS = ['31337', '7', '4242', '11', '9', '12', '21', '33', '64', '101']
/** T23.19D F2: the halo's ring (world px round its centre, 14 up the stone: `cell.ts`), outside the stone grown by 3. */
const HALO_RING = 22
/**
 * Mean luminance the ring gains with the grave shown, at night (min) and at noon (max). Measured (T23.19D, seed
 * 31337, low tier): night +6.5–7.6, noon −0.06–0.06 alone and **+0.67 once in a 14-check run** (T23.19E: frame noise
 * under load); the halo drawn at noon (the review's bug, planted) reads as night does, +7.58. The noon bound is half of
 * the halo's smallest step (a quarter of full night's alpha, `NIGHT_HALO_STEPS`: ~1.7 lum) — any halo at all fails it.
 */
const HALO_NIGHT_MIN = 3.8
const HALO_NOON_MAX = 0.9
/**
 * T23.19D F3: a label's glyph edge contrast — the 98th percentile of |Δ luminance| between neighbouring pixels across
 * its box. Measured on the low tier (T23.19D): sharp 188.1 / 187.2 (bazooka / medkit), the same crops blurred 3×3
 * 74.6 / 78.0; the floor sits between.
 */
const LABEL_EDGE_MIN = 130

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
function p95(rgba) {
  const v = []
  for (let i = 0; i < rgba.length; i += 4) v.push(lum(rgba, i))
  v.sort((a, b) => a - b)
  return v[Math.floor(v.length * 0.95)] ?? 0
}

async function rectOf(page, x0, y0, x1, y1) {
  const a = await toScreen(page, x0, y0)
  const b = await toScreen(page, x1, y1)
  if (!a.onScreen || !b.onScreen) return null
  return { x: Math.round(a.x), y: Math.round(a.y), w: Math.max(4, Math.round(b.x - a.x)), h: Math.max(4, Math.round(b.y - a.y)) }
}

/** The first solid row at or below `y` in column `x` (world px), searched `span` down. */
async function groundBelow(page, x, y, span = 200) {
  return page.evaluate(([x, y, span]) => {
    const c = window.__game.core
    for (let d = 0; d < span; d++) if (c.solidAt(Math.round(x), Math.round(y + d))) return Math.round(y + d)
    return null
  }, [x, y, span])
}

/** Luminance of `rgba` (flat 0..255) as a w×h array. */
function lums(rgba) {
  const out = new Float32Array(rgba.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = lum(rgba, i * 4)
  return out
}

/** The p98 of |Δ luminance| between horizontal and vertical neighbours — how hard the edges in a crop are. */
function edgeP98(L, w, h) {
  const g = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x + 1 < w) g.push(Math.abs(L[y * w + x + 1] - L[y * w + x]))
      if (y + 1 < h) g.push(Math.abs(L[(y + 1) * w + x] - L[y * w + x]))
    }
  }
  g.sort((a, b) => a - b)
  return g[Math.floor(g.length * 0.98)] ?? 0
}

/** The crop box-blurred 3×3 — the control: text drawn soft, as a half-resolution canvas upscaled draws it. */
function blur3(L, w, h) {
  const out = new Float32Array(L.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        s += L[yy * w + xx]
        n++
      }
      out[y * w + x] = s / n
    }
  }
  return out
}

/**
 * T23.19D F1 (`furniture-world-off`): no world renderer — the stub, as without WebGL2. The furniture must be Phaser's
 * (`inWorld` false) **and on screen**: each box changes with it hidden, beside a control box that does not.
 */
async function worldOff({ page, shot, log }) {
  await page.waitForFunction(() => window.__game && window.__game.debug().player, null, { timeout: 120_000 })
  const problems = []
  const k = await page.evaluate(() => window.__game.constants())
  const three = await page.evaluate(() => !!document.querySelector('canvas[data-world="three"]'))
  if (three) problems.push('?world=off still put a three.js world canvas on the page — this is not the no-renderer leg')
  const me = (await page.evaluate(() => window.__game.debug())).player
  const gx = me.x + 60
  const gy = await groundBelow(page, gx, me.y - 40)
  const ax = me.x - 60
  const ay = await groundBelow(page, ax, me.y - 40)
  if (gy === null || ay === null) throw new Error(`no ground beside the player at ${Math.round(me.x)},${Math.round(me.y)}`)
  const stage = (on) => page.evaluate(([g, a, v]) => window.__game.stageFurniture({ graves: [g], animals: a, visible: v, glow: false }), [
    { x: gx, y: gy - k.TOMBSTONE_H / 2 },
    [{ kind: 1, x: ax - 14, y: ay - k.BEETLE_H / 2 }, { kind: 0, x: ax + 14, y: ay - k.SPIDER_H / 2 }],
    on,
  ])
  const staged = await stage(true)
  if (staged.inWorld !== false) problems.push(`with no world renderer the graves/animals still say they are the world's (inWorld ${staged.inWorld})`)
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__game.freeze(true))
  const onOff = makeOnOff(page, log, problems)
  const grect = await rectOf(page, gx - k.TOMBSTONE_W / 2 - 2, gy - k.TOMBSTONE_H - 2, gx + k.TOMBSTONE_W / 2 + 2, gy + 1)
  // Tight to the two bodies (T23.10: at zoom 1 the ±26 px box was 9 % legs and 91 % ground).
  const arect = await rectOf(page, ax - 14 - k.BEETLE_W / 2, ay - Math.max(k.BEETLE_H, k.SPIDER_H) - 1, ax + 14 + k.SPIDER_W / 2, ay + 1)
  if (!grect || !arect) problems.push('the staged graves/animals are off camera')
  else {
    await onOff('world off: a grave (Phaser)', (on) => stage(on), grect)
    await onOff('world off: a beetle and a spider (Phaser)', (on) => stage(on), arect, -1)
  }
  await shot('furniture-world-off-grave')
  await page.evaluate(() => window.__game.freeze(false))
  await page.evaluate(() => window.__game.stageFurniture(null))
  const px = me.x + 40
  const py = (await groundBelow(page, px, me.y - 40)) - 10
  const pickup = (on) => page.evaluate(([v, x, y]) => window.__game.stagePickup(v ? x : null, y, 'bazooka'), [on, px, py])
  const got = await pickup(true)
  if (got.drawn !== 1) problems.push(`world off: staged a pickup, the layer holds ${got.drawn}`)
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__game.freeze(true))
  // The pickup itself (its label sits a figure's height up since T23.19D, measured by the main leg).
  const pr = await rectOf(page, px - 8, py - 6, px + 8, py + 6)
  if (pr) await onOff('world off: the bazooka pickup (Phaser)', pickup, pr)
  else problems.push('world off: the pickup is off camera')
  const inWorld = await page.evaluate(() => window.__game.debug().itemsInWorld)
  if (inWorld !== false) problems.push(`world off: the pickups say they are the world renderer's (itemsInWorld ${inWorld})`)
  await shot('furniture-world-off-pickup')
  await page.evaluate(() => window.__game.freeze(false))
  await page.evaluate(() => window.__game.stagePickup(null))
  if (problems.length) throw new Error(`furniture (world off): ${problems.join('; ')}`)
}

/** One thing on and off on a frozen frame: its box's changed share and a control box's. */
function makeOnOff(page, log, problems) {
  return async function onOff(label, show, rect, side = 1) {
    await show(true)
    await page.waitForTimeout(300)
    const withIt = await photo(page)
    await show(false)
    await page.waitForTimeout(300)
    const without = await photo(page)
    await show(true)
    // The control region: as big, 140 px to one side (away from the other staged things), clamped to the page.
    const cx = side > 0 ? rect.x + rect.w + 140 : rect.x - rect.w - 140
    const control = { ...rect, x: Math.max(0, Math.min(1280 - rect.w, cx)) }
    const moved = (await comparePhotos(page, withIt, without, { rect })).fraction
    const c = (await comparePhotos(page, withIt, without, { rect: control })).fraction
    log(`${label}: ${(moved * 100).toFixed(1)} % of its box changes with it hidden (min ${MIN_CHANGED * 100}); control ${(c * 100).toFixed(1)} %`)
    if (!(moved >= MIN_CHANGED)) problems.push(`${label}: only ${(moved * 100).toFixed(1)} % of its box changes — not drawn`)
    if (!(c <= MAX_CONTROL)) problems.push(`${label}: the control box moved ${(c * 100).toFixed(1)} %`)
    return { withIt, without }
  }
}

export default async function (ctx) {
  const { page, shot, log } = ctx
  if (new URL(page.url()).searchParams.get('world') === 'off') return worldOff(ctx)
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  const problems = []
  const k = await page.evaluate(() => window.__game.constants())

  // A map with crystals.
  let crystals = null
  for (const seed of SEEDS) {
    await page.evaluate((s) => window.__game.regenerate(s), seed)
    await page.waitForFunction(() => window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
    const c = await page.evaluate(() => window.__game.showCrystals(true))
    if (c.stamps > 0) {
      crystals = { seed, ...c }
      break
    }
  }
  if (!crystals) throw new Error(`no crystals on seeds ${SEEDS.join(' ')}`)
  log(`seed ${crystals.seed}: ${crystals.stamps} crystal stamps at ${crystals.at.map((o) => `${o.x},${o.y} ${o.w}x${o.h}`).join('; ')}`)

  await page.evaluate((t) => window.__game.setTime(t), NIGHT_T)
  const dark = (await page.evaluate(() => window.__game.debug())).darkness
  if (!(dark > 0.5)) problems.push(`setTime(${NIGHT_T}) is not night: darkness ${dark}`)

  const onOff = makeOnOff(page, log, problems)

  // 1. A crystal stamp: the crystals toggled, and their light in the list.
  const cs = crystals.at[0]
  await page.evaluate(([x, y]) => window.__game.place(x, y), [cs.x + cs.w / 2 + 70, cs.y + cs.h - k.PLAYER_H])
  await page.waitForTimeout(1200)
  await page.evaluate(() => window.__game.freeze(true))
  const lights = await page.evaluate(() => window.__game.effectLights())
  const crystalLight = lights.filter((l) => l.kind === 'static' && Math.abs(l.x - (cs.x + cs.w / 2)) < 1)
  if (crystalLight.length !== 1) problems.push(`the crystal stamp at ${cs.x},${cs.y} has ${crystalLight.length} lights in the list (want 1)`)
  // The cluster, not the whole stamp: one F1-sized cluster (≤ 32 px, `furniture.ts::CRYSTAL_S_MAX`) on the stamp's
  // base middle, its glow ±22 about 8 up — the stamp's own rect is mostly rock the crystals do not touch.
  const base = cs.y + cs.h
  const cx = cs.x + cs.w / 2
  const cr = await rectOf(page, cx - 20, base - Math.min(cs.h, 34) - 4, cx + 20, base + 2)
  if (!cr) problems.push('the crystal stamp is off camera')
  else {
    await onOff('crystals', (on) => page.evaluate((v) => window.__game.showCrystals(v), on), cr)
    await shot('furniture-crystals')
  }
  await page.evaluate(() => window.__game.freeze(false))

  // 2. Graves and animals, staged on the ground beside the player, at night.
  const me = (await page.evaluate(() => window.__game.debug())).player
  const gx = me.x + 60
  const gy = await groundBelow(page, gx, me.y - 40)
  const ax = me.x - 60
  const ay = await groundBelow(page, ax, me.y - 40)
  if (gy === null || ay === null) throw new Error(`no ground beside the player at ${Math.round(me.x)},${Math.round(me.y)}`)
  log(`player ${Math.round(me.x)},${Math.round(me.y)}; grave on ground ${Math.round(gx)},${gy}; animals on ground ${Math.round(ax)},${ay}`)
  const stage = (on) => page.evaluate(([g, a, v]) => window.__game.stageFurniture({ graves: [g], animals: a, visible: v, glow: false }), [
    { x: gx, y: gy - k.TOMBSTONE_H / 2 },
    [{ kind: 1, x: ax - 14, y: ay - k.BEETLE_H / 2 }, { kind: 0, x: ax + 14, y: ay - k.SPIDER_H / 2 }],
    on,
  ])
  const staged = await stage(true)
  if (!staged.inWorld) problems.push('graves/animals are not drawn by the world renderer')
  if (staged.graves !== 1 || staged.animals.length !== 2) problems.push(`staged 1 grave, 2 animals; the layers hold ${staged.graves}, ${staged.animals.length}`)
  await page.waitForTimeout(800)
  await page.evaluate(() => window.__game.freeze(true))
  const grect = await rectOf(page, gx - k.TOMBSTONE_W / 2 - 2, gy - k.TOMBSTONE_H - 2, gx + k.TOMBSTONE_W / 2 + 2, gy + 1)
  const arect = await rectOf(page, ax - 26, ay - 16, ax + 26, ay + 1)
  if (!grect || !arect) problems.push('the staged graves/animals are off camera')
  else {
    await onOff('a grave at night', (on) => stage(on), grect)
    await onOff('a beetle and a spider', (on) => stage(on), arect, -1)
    await shot('furniture-grave-night')
    // Reads against the rock: the grave's box against the same-size rock just beside it (both on this frame).
    const rock = { ...grect, x: grect.x + grect.w + 6 }
    const g95 = p95((await patchRGBA(page, grect)).rgba)
    const r95 = p95((await patchRGBA(page, rock)).rgba)
    log(`the grave at night: luminance p95 ${g95.toFixed(1)} against the rock beside it ${r95.toFixed(1)} (lift min ${GRAVE_LIFT})`)
    if (!(g95 - r95 >= GRAVE_LIFT)) problems.push(`the grave at night lifts only ${(g95 - r95).toFixed(1)} over the rock beside it — it does not read`)

    // T23.19D F2: the halo's ring, at night (the control: it is there) and at noon (it is not).
    const hc = { x: gx, y: gy - 14 }
    const ring = await rectOf(page, hc.x - HALO_RING, hc.y - HALO_RING, hc.x + HALO_RING, hc.y + HALO_RING)
    const stone = await rectOf(page, gx - k.TOMBSTONE_W / 2 - 3, gy - k.TOMBSTONE_H - 3, gx + k.TOMBSTONE_W / 2 + 3, gy + 3)
    async function ringLift() {
      await page.evaluate(() => window.__game.freeze(false))
      await stage(true)
      await page.waitForTimeout(400)
      await page.evaluate(() => window.__game.freeze(true))
      const a = lums((await patchRGBA(page, ring)).rgba)
      await stage(false)
      await page.waitForTimeout(300)
      const b = lums((await patchRGBA(page, ring)).rgba)
      await stage(true)
      let s = 0
      let n = 0
      for (let y = 0; y < ring.h; y++) {
        for (let x = 0; x < ring.w; x++) {
          const sx = ring.x + x
          const sy = ring.y + y
          if (sx >= stone.x && sx < stone.x + stone.w && sy >= stone.y && sy < stone.y + stone.h) continue
          s += a[y * ring.w + x] - b[y * ring.w + x]
          n++
        }
      }
      return n ? s / n : NaN
    }
    if (!ring || !stone) problems.push('the halo ring is off camera')
    else {
      const night = await ringLift()
      let noonT = null
      for (const t of [0, 10, 20, 30, 40, 50, 60]) {
        await page.evaluate((v) => window.__game.setTime(v), t)
        if ((await page.evaluate(() => window.__game.debug())).darkness === 0) {
          noonT = t
          break
        }
      }
      if (noonT === null) problems.push('no setTime in 0..60 s gives darkness 0 — no noon to stage')
      else {
        const noon = await ringLift()
        log(`the halo ring (${HALO_RING} px round its centre, stone excluded): night +${night.toFixed(2)} lum (min ${HALO_NIGHT_MIN}); noon (setTime ${noonT}) +${noon.toFixed(2)} (max ${HALO_NOON_MAX})`)
        if (!(night >= HALO_NIGHT_MIN)) problems.push(`the night halo lifts its ring only ${night.toFixed(2)} at night — the control shows no halo`)
        if (!(noon <= HALO_NOON_MAX)) problems.push(`the night halo is drawn at noon: its ring lifts ${noon.toFixed(2)}`)
        await shot('furniture-grave-noon')
      }
      await page.evaluate((t) => window.__game.setTime(t), NIGHT_T)
    }
  }
  await page.evaluate(() => window.__game.freeze(false))
  await page.evaluate(() => window.__game.stageFurniture(null))

  // 3. Pickups: a weapon (its model) and an item, and the label over a near one.
  for (const key of ['bazooka', 'medkit']) {
    const px = me.x + 40
    const py = (await groundBelow(page, px, me.y - 40)) - 10
    const pickup = (on) => page.evaluate(([v, x, y, kk]) => window.__game.stagePickup(v ? x : null, y, kk), [on, px, py, key])
    const got = await pickup(true)
    if (got.drawn !== 1) problems.push(`${key}: staged a pickup, the layer holds ${got.drawn}`)
    await page.waitForTimeout(600)
    await page.evaluate(() => window.__game.freeze(true))
    const pr = await rectOf(page, px - 16, py - 30, px + 16, py + 10)
    if (pr) await onOff(`the ${key} pickup and its label`, pickup, pr)
    else problems.push(`${key}: the pickup is off camera`)
    // T23.19D F3: the label — Phaser text at the camera's zoom, sharp on the low tier.
    const dbg = await page.evaluate(() => ({ labels: window.__game.debug().labels, zoom: window.__game.constants().CAMERA_ZOOM, tier: window.__world.info().tier }))
    if (dbg.labels?.length !== 1) problems.push(`${key}: ${dbg.labels?.length} labels up, want 1`)
    else {
      const l = dbg.labels[0]
      if (l.resolution !== dbg.zoom) problems.push(`${key}: the label is rasterised at ${l.resolution}×, the camera draws it at ${dbg.zoom}×`)
      const half = (l.text.length * 7) / 2
      const lr = await rectOf(page, l.x - half, l.y - 13, l.x + half, l.y)
      if (!lr) problems.push(`${key}: the label is off camera`)
      else {
        const crop = await patchRGBA(page, lr)
        const L = lums(crop.rgba)
        const sharp = edgeP98(L, crop.w, crop.h)
        const soft = edgeP98(blur3(L, crop.w, crop.h), crop.w, crop.h)
        log(`${key}'s label "${l.text}" (${dbg.tier} tier): glyph edge p98 ${sharp.toFixed(1)} (min ${LABEL_EDGE_MIN}); the same crop blurred 3×3 ${soft.toFixed(1)}`)
        if (!(sharp >= LABEL_EDGE_MIN)) problems.push(`${key}'s label edges are soft: p98 ${sharp.toFixed(1)} < ${LABEL_EDGE_MIN}`)
        if (!(soft < LABEL_EDGE_MIN)) problems.push(`the blurred control passes the label floor (${soft.toFixed(1)}) — the floor sees no blur`)
      }
    }
    await shot(`furniture-pickup-${key}`)
    await page.evaluate(() => window.__game.freeze(false))
  }
  const inWorld = await page.evaluate(() => window.__game.debug().itemsInWorld)
  if (inWorld !== true) problems.push(`the pickups are not the world renderer's (itemsInWorld ${inWorld})`)
  await page.evaluate(() => window.__game.stagePickup(null))
  await page.evaluate(() => window.__game.setTime(null))

  if (problems.length) throw new Error(`furniture: ${problems.join('; ')}`)
}
