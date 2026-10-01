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
 *
 * **The Islands' cloud sea** (the look §A5 asks for): under its tops (`ISLANDS_CLOUD_SEA_FRAC`) the frame with the
 * sea must differ from the same frame with the sea's layer hidden (`__world.hideLayers(['cloudSea'])`) at ≥
 * `MIN_PAINTED` of the probes; control: probes high in the sky are the same in both frames, and on Mostly flat the
 * renderer drew no sea (`atmosphere().cloudSea` false).
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
    if (name === 'islands') await cloudSea(page, meta, log, shot)
  }
  await frame(page, 'flat')
  const flatSea = await page.evaluate(() => window.__world.atmosphere()?.cloudSea)
  if (flatSea !== false) throw new Error(`control: Mostly flat reports a cloud sea drawn (${flatSea})`)
}

async function cloudSea(page, meta, log, shot) {
  await frame(page, 'islands')
  const drawn = await page.evaluate(() => window.__world.atmosphere()?.cloudSea)
  if (drawn !== true) throw new Error(`islands: the renderer says no cloud sea was drawn (${drawn})`)
  const frac = await page.evaluate(() => window.__game.constants().ISLANDS_CLOUD_SEA_FRAC)
  const probe = async (wy) => {
    const out = []
    for (let i = 1; i <= 12; i++) {
      const p = await toScreen(page, (meta.w * i) / 13, wy)
      if (p.x > 380 && p.x < 1270 && p.y > 0 && p.y < 780) out.push(p)
    }
    return out
  }
  const sea = await probe(meta.h * (frac + (1 - frac) / 2))
  const sky = await probe(meta.h * 0.08)
  const withSea = await photo(page)
  await shot('map-shapes-islands-sea')
  await page.evaluate(() => window.__world.hideLayers(['cloudSea']))
  await page.waitForTimeout(500)
  const without = await photo(page)
  await page.evaluate(() => window.__world.hideLayers([]))
  const seaMoved = (await comparePhotos(page, without, withSea, { points: sea })).points.filter(Boolean).length / Math.max(1, sea.length)
  const skyMoved = (await comparePhotos(page, without, withSea, { points: sky })).points.filter(Boolean).length / Math.max(1, sky.length)
  log(`islands cloud sea: ${sea.length} probes under its tops painted ${seaMoved.toFixed(2)} (≥ ${MIN_PAINTED}); ${sky.length} sky probes ${skyMoved.toFixed(2)} (≤ ${MAX_SAME_DIFF})`)
  if (sea.length < 5 || seaMoved < MIN_PAINTED) throw new Error(`islands: the cloud sea is not on screen where it should be (${seaMoved.toFixed(2)} of ${sea.length})`)
  if (skyMoved > MAX_SAME_DIFF) throw new Error(`islands: hiding the sea changed the sky too (${skyMoved.toFixed(2)})`)
}

