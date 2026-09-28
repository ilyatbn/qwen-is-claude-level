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

export default async function ({ page, shot, log }) {
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

  /** One thing on and off on a frozen frame: its box's changed share and a control box's. */
  async function onOff(label, show, rect, side = 1) {
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
  const stage = (on) => page.evaluate(([g, a, v]) => window.__game.stageFurniture({ graves: [g], animals: a, visible: v }), [
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
    await shot(`furniture-pickup-${key}`)
    await page.evaluate(() => window.__game.freeze(false))
  }
  const inWorld = await page.evaluate(() => window.__game.debug().itemsInWorld)
  if (inWorld !== true) problems.push(`the pickups are not the world renderer's (itemsInWorld ${inWorld})`)
  await page.evaluate(() => window.__game.stagePickup(null))
  await page.evaluate(() => window.__game.setTime(null))

  if (problems.length) throw new Error(`furniture: ${problems.join('; ')}`)
}
