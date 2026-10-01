/**
 * `map-shapes` — T23.30 (`docs/78` §A5): each map shape loads in the sandbox (`?shape=` /
 * `regenerate(seed, scale, gravity, shape)`), says what it is (`meta.shape`), and **is drawn**.
 *
 * The pixel half: one seed, one camera (the whole Medium map at zoom 0.5, the player hidden, the clock
 * held), photographed per shape. Where a shape's mask has rock and Flat's has air — Hill's hills, the
 * islands each shape hangs — the photograph must differ from Flat's at that point; a shape that changed
 * the mask but not the picture (a renderer never told) fails here. **Control:** the same shape generated
 * twice photographs the same at those points, so a difference is the shape's and not the sky's animation.
 * Every shape's photograph is written (`shots/map-shapes-<shape>.png`) for a person to look at.
 */
import { photo, comparePhotos, toScreen } from './pixels.mjs'

const SEED = '4242'
/** Of the probe points (rock in the shape, air in Flat), at least this share must be painted differently. */
const MIN_PAINTED = 0.8
/** The same shape twice: at most this share of the probe points may differ (the animated sky's allowance). */
const MAX_SAME_DIFF = 0.05
const PROBES = 40

async function frame(page, shape) {
  await page.evaluate((s) => window.__game.regenerate(s[0], 'medium', 'standard', s[1]), [SEED, shape])
  await page.waitForFunction(() => !!window.__world?.terrain?.()?.ready, null, { timeout: 120_000 })
  const meta = await page.evaluate(() => {
    const c = window.__game.core
    return { shape: c.meta.shape, w: c.width, h: c.height }
  })
  await page.evaluate(([w, h]) => {
    window.__game.showPlayer(false)
    window.__game.setTime(0.3)
    window.__game.setZoom(0.5)
    window.__game.watch(w / 2, h * 0.6)
  }, [meta.w, meta.h])
  await page.waitForTimeout(1500)
  return meta
}

/** World points (on screen) where `solid` holds in this map, sampled on a grid. */
async function solidGrid(page) {
  return page.evaluate(() => {
    const c = window.__game.core
    const out = []
    for (let y = 8; y < c.height; y += 16) for (let x = 8; x < c.width; x += 16) out.push(c.solidAt(x, y) ? 1 : 0)
    return { cols: Math.ceil((c.width - 8) / 16), bits: out }
  })
}

export default async function ({ page, shot, log }) {
  const names = await page.evaluate(() => [...window.__game.constants().MAP_SHAPES ?? []])
  if (names.length < 2) throw new Error(`MAP_SHAPES reads ${JSON.stringify(names)} — the constants export is missing`)

  const flatMeta = await frame(page, 'flat')
  if (flatMeta.shape !== 'Flat') throw new Error(`?shape=flat generated ${flatMeta.shape}`)
  const flatGrid = await solidGrid(page)
  const flatPhoto = await photo(page)
  await shot('map-shapes-flat')

  for (const name of names.filter((n) => n !== 'flat')) {
    const meta = await frame(page, name)
    const want = name[0].toUpperCase() + name.slice(1)
    if (meta.shape !== want) throw new Error(`shape ${name}: the map says ${meta.shape}`)
    const grid = await solidGrid(page)
    // Rock here, air in Flat: the cells that only this shape paints.
    const cells = []
    grid.bits.forEach((b, i) => {
      if (b && !flatGrid.bits[i]) cells.push([8 + (i % grid.cols) * 16, 8 + Math.floor(i / grid.cols) * 16])
    })
    const step = Math.max(1, Math.floor(cells.length / PROBES))
    const points = []
    for (let i = 0; i < cells.length && points.length < PROBES; i += step) {
      const p = await toScreen(page, cells[i][0], cells[i][1])
      if (p.x > 380 && p.y > 360 && p.x < 1270 && p.y < 700) points.push(p) // off the dev panel, HUD, minimap
    }
    const a = await photo(page)
    await shot(`map-shapes-${name}`)
    if (points.length < 5) {
      log(`${name}: ${cells.length} cells differ from Flat, ${points.length} on screen — no pixel probe`)
      if (name !== 'random') throw new Error(`${name}: too few on-screen points where it differs from Flat`)
      continue
    }
    const painted = (await comparePhotos(page, flatPhoto, a, { points })).points.filter(Boolean).length / points.length
    // Control: the same shape again, same camera.
    await frame(page, name)
    const again = await photo(page)
    const same = (await comparePhotos(page, a, again, { points })).points.filter(Boolean).length / points.length
    log(`${name}: ${cells.length} cells rock here and air in Flat; probes ${points.length}: painted ${painted.toFixed(2)} vs Flat (≥ ${MIN_PAINTED}), ${same.toFixed(2)} vs itself (≤ ${MAX_SAME_DIFF})`)
    if (painted < MIN_PAINTED) throw new Error(`${name}: only ${painted.toFixed(2)} of the points where it has rock and Flat has air are painted differently`)
    if (same > MAX_SAME_DIFF) throw new Error(`${name}: the control moved — ${same.toFixed(2)} of the points differ between two generations of the same shape`)
  }
}
