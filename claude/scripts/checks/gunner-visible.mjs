/**
 * `gunner-visible` — T23.19A: a player on a turret, in a gate and over a pickup is **seen**.
 *
 * The world renderer's canvas lies under Phaser's, so every layer Phaser still drew covered the figures: a player
 * mounted on a turret showed only a flame and a name tag (shots/t2314b-match-jet-gpu.png). Gates and turrets are now
 * the world renderer's, ordered behind the figures; since T23.19 the pickups (and labels, graves, animals) are too,
 * and T23.19A's stopgap (a figure over a pickup drawn through Phaser) is retired.
 *
 * Asserted on the **page** — both canvases composited, which is what a player sees — never on the world canvas
 * alone, where the figure was always intact. For each case, the scene frozen: the figure's box photographed with
 * the figure's footprint is what it changes with the layer hidden, and at least `MIN_VISIBLE` of it must still change
 * with the layer drawn — nothing covers it — while a control box away from it moves in at most `MAX_CONTROL`. The layer
 * itself is proven present in the same frames (its own pair), so "the figure shows" cannot be a turret or gate that is
 * simply not drawn.
 */
import { comparePhotos, photo, toScreen } from './pixels.mjs'

/**
 * How much of the figure must still show with the layer present: of the pixels the figure changes when nothing is in
 * front of it (the layer hidden — its **footprint**), the fraction that still change with the layer drawn. Not 1.0 even
 * when nothing covers it: F's ink figure over F's ink turret or a dark icon is ink on ink (the rim light is what
 * separates them), so each case's floor sits between its own two measurements (T23.19A, SwiftShader, seeds below):
 *   turret  fixed 0.870 — bug (turret on Phaser, over the figure) 0.147
 *   gate    fixed 0.963 — bug 0.429 (the old arch's portal is a hole, so part of the figure showed through it)
 *   pickup  fixed 0.920 — stopgap off 0.782
 */
const MIN_VISIBLE = { turret: 0.6, gate: 0.75, pickup: 0.85 }
/** A footprint smaller than this many px is not a figure (the hide did nothing, or the box missed it). */
const MIN_FOOTPRINT = 60
/** The control box's allowance: the frozen scene does not move elsewhere (measured 0.000). */
const MAX_CONTROL = 0.02
/** The figure's box about its feet, world px: ~36 px tall at `FIGURE_SCALE` 1.15, arms and a held weapon within ±11. */
const BOX = { halfW: 11, up: 38, down: 1 }
/** A pixel counts as changed above this per-channel step (`pixels.mjs::PIXEL_MOVED`). */
const MOVED = 6

async function screenRect(page, x0, y0, x1, y1) {
  const a = await toScreen(page, x0, y0)
  const b = await toScreen(page, x1, y1)
  if (!a.onScreen || !b.onScreen) throw new Error(`(${Math.round(x0)},${Math.round(y0)})–(${Math.round(x1)},${Math.round(y1)}) is off camera`)
  return { x: Math.round(a.x), y: Math.round(a.y), w: Math.max(4, Math.round(b.x - a.x)), h: Math.max(4, Math.round(b.y - a.y)) }
}

/** In `rect`: the pixels that change between `a` and `b` (the footprint), and how many of them change between `c` and `d`. */
function visibleShare(page, [a, b, c, d], rect) {
  return page.evaluate(
    async ([srcs, box, t]) => {
      const load = async (src) => {
        const img = new Image()
        img.src = `data:image/png;base64,${src}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return { d: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width }
      }
      const [A, B, C, D] = await Promise.all(srcs.map(load))
      const moved = (P, Q, i) => Math.max(Math.abs(P.d[i] - Q.d[i]), Math.abs(P.d[i + 1] - Q.d[i + 1]), Math.abs(P.d[i + 2] - Q.d[i + 2])) > t
      let foot = 0
      let seen = 0
      for (let y = box.y; y < box.y + box.h; y++)
        for (let x = box.x; x < box.x + box.w; x++) {
          const i = (y * A.w + x) * 4
          if (!moved(A, B, i)) continue
          foot++
          if (moved(C, D, i)) seen++
        }
      return { foot, seen }
    },
    [[a, b, c, d], rect, MOVED],
  )
}

/**
 * The frozen scene, four photographs: the figure shown and hidden with the layer drawn, then with it hidden. The
 * figure's footprint is what it changes with nothing in front; the share of it still changing with the layer drawn is
 * how much of the figure a player sees. The layer's own pair proves it is drawn at all.
 */
async function figureShows(page, label, shot, layer, layerRect) {
  const d = await page.evaluate(() => window.__game.debug())
  const k = await page.evaluate(() => window.__game.constants())
  const feet = d.player.y + k.PLAYER_H / 2
  const box = await screenRect(page, d.player.x - BOX.halfW, feet - BOX.up, d.player.x + BOX.halfW, feet + BOX.down)
  let control = null
  for (const dx of [80, -80, 120, -120]) {
    try {
      control = await screenRect(page, d.player.x + dx - BOX.halfW, feet - BOX.up, d.player.x + dx + BOX.halfW, feet + BOX.down)
      break
    } catch {
      /* off camera: the other side */
    }
  }
  if (!control) throw new Error(`${label}: no on-camera control box`)
  const figure = async (on) => {
    const r = await page.evaluate((v) => window.__game.showPlayer(v), on)
    if (r.visible !== on) throw new Error(`${label}: showPlayer(${on}) did not take`)
    await page.waitForTimeout(250)
    return r
  }
  const shown = await photo(page)
  await shot(`gunner-visible-${label}`)
  await figure(false)
  const hidden = await photo(page)
  await layer(false)
  await page.waitForTimeout(250)
  const bare = await photo(page)
  await figure(true)
  const alone = await photo(page)
  await layer(true)
  await page.waitForTimeout(250)
  const v = await visibleShare(page, [alone, bare, shown, hidden], box)
  const lay = layerRect ? (await comparePhotos(page, hidden, bare, { rect: layerRect })).fraction : null
  const c = (await comparePhotos(page, shown, hidden, { rect: control })).fraction
  return { ...v, share: v.foot ? v.seen / v.foot : 0, c, lay }
}

/** Let the camera arrive at the placed body (it eases; a loaded box eases slowly), then freeze the scene. */
async function settle(page) {
  await page.waitForTimeout(700)
  const k = await page.evaluate(() => window.__game.constants())
  for (let i = 0; i < 40; i++) {
    const p = (await page.evaluate(() => window.__game.debug())).player
    const a = await toScreen(page, p.x - BOX.halfW - 40, p.y + k.PLAYER_H / 2 - BOX.up - 30)
    const b = await toScreen(page, p.x + BOX.halfW + 40, p.y + k.PLAYER_H / 2 + 10)
    if (a.onScreen && b.onScreen) break
    await page.waitForTimeout(250)
  }
  await page.evaluate(() => window.__game.freeze(true))
  await page.waitForTimeout(250)
}

export default async function ({ page, shot, log }) {
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  const problems = []
  const judge = (label, r, min) => {
    log(
      `${label}: ${(r.share * 100).toFixed(1)} % of the figure's ${r.foot}-px footprint shows (min ${min * 100}); ` +
        `control ${(r.c * 100).toFixed(1)} % (max ${MAX_CONTROL * 100})` +
        (r.lay === null ? '' : `; the layer itself changes ${(r.lay * 100).toFixed(1)} % of its box`),
    )
    if (!(r.foot >= MIN_FOOTPRINT)) problems.push(`${label}: the figure's footprint is only ${r.foot} px — no figure was photographed`)
    if (!(r.share >= min)) problems.push(`${label}: only ${(r.share * 100).toFixed(1)} % of the figure shows — something covers it`)
    if (!(r.c <= MAX_CONTROL)) problems.push(`${label}: the control box moved ${(r.c * 100).toFixed(1)} % — the frame is not still`)
    if (r.lay !== null && !(r.lay >= 0.2)) problems.push(`${label}: hiding the layer changed only ${(r.lay * 100).toFixed(1)} % of its box — it is not drawn`)
  }
  await page.evaluate(() => window.__game.setTime(0))
  const k = await page.evaluate(() => window.__game.constants())

  // --- 1. mounted on a turret ---------------------------------------------------------------------------------
  await page.evaluate(() => window.__game.regenerate('31337', 'medium'))
  await page.waitForFunction(() => window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  const plats = await page.evaluate(() => window.__game.platforms())
  if (!(plats.count >= 1)) throw new Error('seed 31337 medium carries no platform')
  if (plats.turretsInWorld !== plats.count) problems.push(`${plats.count} platforms, ${plats.turretsInWorld} turrets in the world renderer`)
  const t = plats.at[0]
  await page.evaluate(([x, y]) => window.__game.place(x, y), [t.x, t.y - k.PLAYER_H / 2 - 1])
  await page.waitForTimeout(500)
  const rode = await page.evaluate(() => window.__game.mountNearestPlatform(true))
  if (rode.mounted !== true) throw new Error(`could not mount: ${JSON.stringify(rode)}`)
  await settle(page)
  const tb = await screenRect(page, t.x - plats.turret.w / 2, t.y - plats.turret.h, t.x + plats.turret.w / 2, t.y)
  judge('mounted on a turret', await figureShows(page, 'turret', shot, (on) => page.evaluate((v) => window.__game.showPlatforms(v), on), tb), MIN_VISIBLE.turret)
  await page.evaluate(() => window.__game.freeze(false))
  await page.evaluate(() => window.__game.mountNearestPlatform(false))

  // --- 2. standing in a gate ----------------------------------------------------------------------------------
  await page.evaluate(() => window.__game.regenerate('7'))
  await page.waitForFunction(() => window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  const pads = await page.evaluate(() => window.__game.core.meta.teleport_pads.map((p) => p.pos))
  if (!pads.length) throw new Error('seed 7 carries no pad')
  const g = pads[0]
  await page.evaluate(([x, y]) => window.__game.place(x, y), [g.x, g.y - k.PLAYER_H / 2 - 1])
  await settle(page)
  const gw = k.PAD_ART_W
  const gb = await screenRect(page, g.x - gw / 2, g.y - gw * 0.75, g.x + gw / 2, g.y)
  judge('standing in a gate', await figureShows(page, 'gate', shot, (on) => page.evaluate((v) => window.__game.showPads(v), on), gb), MIN_VISIBLE.gate)
  await page.evaluate(() => window.__game.freeze(false))

  // --- 3. over a pickup (T23.19: pickups are the world renderer's, behind the figure — T23.19A's stopgap retired) --
  const me = (await page.evaluate(() => window.__game.debug())).player
  const at = [me.x, me.y + k.PLAYER_H / 2 - 8]
  const staged = await page.evaluate(([x, y]) => window.__game.stagePickup(x, y, 'bazooka'), at)
  if (staged.drawn !== 1) problems.push(`staged a pickup, the item layer drew ${staged.drawn}`)
  await settle(page)
  const pickup = (on) => page.evaluate(([v, x, y]) => window.__game.stagePickup(v ? x : null, y, 'bazooka'), [on, ...at])
  const r = await figureShows(page, 'pickup', shot, pickup, null)
  if ((await page.evaluate(() => window.__game.debug().itemsInWorld)) !== true) problems.push('the pickups are not drawn by the world renderer')
  judge('over a pickup', r, MIN_VISIBLE.pickup)
  await page.evaluate(() => window.__game.freeze(false))
  await page.evaluate(() => window.__game.stagePickup(null))
  await page.evaluate(() => window.__game.setTime(null))

  if (problems.length) throw new Error(`gunner-visible: ${problems.join('; ')}`)
}
