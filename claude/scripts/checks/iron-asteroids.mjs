/**
 * T22.21 / R113 — **an iron asteroid is drawn darker than ordinary rock**, on the
 * terrain and on the minimap.
 *
 * The owner: *"lets also have a couple asteroids be even larger, different darker
 * color (lets say made of iron), and be indestructible."* Indestructible is proven in
 * Rust (`map::carve`'s barrage test); this is the half no Rust test can see: the
 * pixels (`docs/72` §C2).
 *
 * ## What is photographed, and the controls
 *
 * The camera rig of `asteroid-cores` (body placed above the rock, sky, time and
 * parallax pinned), held on three frames:
 *
 *  - **frame B** — the largest ordinary rock: the **reference**, a wholly solid patch
 *    of its body outside its core;
 *  - **frame A** — an iron rock: the **subject**, a wholly solid patch of it, and a
 *    **control region** of open space beside it;
 *  - **frame C, the control frame** — frame A's camera and moment with the rock told
 *    it is *not* iron (`Core.setAsteroids`) and its chunk rebaked (a 2 px carve beside
 *    the patch, in the same chunk): the same pixels drawn as ordinary rock.
 *
 * The subject must stand off the reference (colour distance) and read **darker**
 * (luminance, by a margin); in the control frame the subject must change by the
 * same distance and come back near the reference, while the control region does not
 * move — so the darkness was the iron flag's and nothing else in the frame.
 * (Open space is a poor control *between* rocks: the space backdrop puts a planet
 * behind one and stars behind another.) Run on both renderers (`iron-asteroids-canvas`).
 *
 * The **minimap** is read straight off its canvas (the DOM element, the same on both
 * renderers): once the iron has been seen, the cell at its centre is the iron colour
 * — distinct from the cell at the ordinary rock's centre (rock) and from open space.
 *
 * ## No wall-clock sleeps
 *
 * Waits are on rendered frames (`requestAnimationFrame`) and on the minimap's own
 * explored count — never `waitForTimeout`.
 */
import { deadlineMs } from '../lib/deadline.mjs'
import { colourDelta, samplePatch, toScreen } from './pixels.mjs'

/** Mean colour distance iron must stand off ordinary rock by (0..441). */
const DISTINCT_MIN = 40
/** How much darker (mean of r, g, b) iron must read than ordinary rock. */
const DARKER_MIN = 25
/** How far the open-space control region may move between frames A and C. */
const SKY_AGREE_MAX = 12
/** Rendered frames to let a pin, a placement or a rebake reach the screen. */
const SETTLE_FRAMES = 20
/** Minimap colour distance between iron and rock, and iron and open space. */
const MINIMAP_DISTINCT_MIN = 30

export default async function ({ page, shot, log }) {
  const waitFor = async (fn, arg, why, seconds = 20) => {
    try {
      await page.waitForFunction(fn, arg, { timeout: deadlineMs(seconds, why) })
    } catch (e) {
      if (String(e).includes('Timeout')) throw new Error(`${why} (waited ${seconds}s)`)
      throw e
    }
  }
  const frames = async (n) => {
    await page.evaluate(() => {
      window.__e2eFrames = 0
      if (window.__e2eTick) return
      window.__e2eTick = true
      const tick = () => {
        window.__e2eFrames++
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await waitFor((m) => window.__e2eFrames >= m, n, `${n} frames never rendered`)
  }

  await waitFor(() => !!window.__game.debug().player, null, 'the sandbox never produced a local player')
  const k = await page.evaluate(() => window.__game.constants())
  const tag = (await page.evaluate(() => location.search.includes('renderer=canvas'))) ? '-canvas' : ''

  // An iron rock and the largest ordinary one, each with a wholly solid patch and a
  // patch of open space beside it, and the camera able to centre on it.
  const pick = await page.evaluate(
    ([halfW, halfH, bodyH]) => {
      const core = window.__game.core
      const rocks = core.meta.asteroids
      const solidBox = (x, y, half, want) => {
        for (let dy = -half; dy <= half; dy++) {
          for (let dx = -half; dx <= half; dx++) {
            if (core.solidAt(Math.round(x + dx), Math.round(y + dy)) !== want) return false
          }
        }
        return true
      }
      const side = 6
      const fits = (a) =>
        a.x >= halfW && a.x <= core.width - halfW && a.y >= halfH && a.y <= core.height - halfH
      const site = (a, from) => {
        // A solid patch on a downward bearing at `from` px out, and open space just
        // past the rock's bounding radius on the same bearing.
        for (let b = 0; b < 16; b++) {
          const th = Math.PI * (0.1 + (0.8 * b) / 15)
          const [ux, uy] = [Math.cos(th), Math.sin(th)]
          const [x, y] = [a.x + ux * from, a.y + uy * from]
          const [ox, oy] = [a.x + ux * (a.r + 3 * side + 6), a.y + uy * (a.r + 3 * side + 6)]
          if (solidBox(x, y, side, true) && solidBox(ox, oy, 2 * side, false)) {
            return { x: a.x, y: a.y, r: a.r, px: x, py: y, ox, oy, above: a.y - a.r - 3 * bodyH }
          }
        }
        return null
      }
      const irons = rocks.filter((a) => a.iron && fits(a))
      const ordinary = rocks.filter((a) => !a.iron && fits(a)).sort((p, q) => q.r - p.r)
      const iron = irons.map((a) => site(a, a.r * 0.4)).find((s) => s) ?? null
      // Outside its core (0.3 r): half way out.
      const rock = ordinary.map((a) => site(a, a.r * 0.5)).find((s) => s) ?? null
      return { irons: rocks.filter((a) => a.iron).length, iron, rock, side }
    },
    [k.VIEWPORT_W / 2 / k.CAMERA_ZOOM, k.VIEWPORT_H / 2 / k.CAMERA_ZOOM, k.PLAYER_H],
  )
  if (pick.irons === 0) throw new Error('the sandbox space map has no iron asteroid')
  if (!pick.iron || !pick.rock) {
    throw new Error(`no photographable iron (${!!pick.iron}) or ordinary rock (${!!pick.rock}) on this map`)
  }
  log(`iron (${pick.iron.x}, ${pick.iron.y}) r ${pick.iron.r}; rock (${pick.rock.x}, ${pick.rock.y}) r ${pick.rock.r}`)

  const frameOn = async (s, name) => {
    await page.evaluate(([x, y]) => window.__game.place(x, y), [s.x, s.above])
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [s.x, s.y])
    await page.evaluate(() => {
      window.__game.setTime(0)
    })
    const body = await toScreen(page, s.x, s.above)
    await page.mouse.move(Math.max(1, Math.min(1279, Math.round(body.x))), 1)
    await frames(SETTLE_FRAMES)
    const at = await toScreen(page, s.px, s.py)
    const sky = await toScreen(page, s.ox, s.oy)
    if (!at.onScreen || !sky.onScreen) throw new Error(`${name}: the patch is not on screen`)
    const w = Math.max(2, Math.round(pick.side * at.scale))
    const rect = (p) => ({ x: Math.round(p.x - w / 2), y: Math.round(p.y - w / 2), w, h: w })
    const patch = await samplePatch(page, rect(at))
    const open = await samplePatch(page, rect(sky))
    await shot(`iron-asteroids-${name}${tag}`)
    return { patch, open }
  }
  const fmt = (s) => `rgb(${s.r.toFixed(0)}, ${s.g.toFixed(0)}, ${s.b.toFixed(0)})`
  const lum = (s) => (s.r + s.g + s.b) / 3

  /**
   * T23.20: the paint under a world patch — `__world.readAlbedo`, the lit terrain's albedo
   * (mean r, g, b of the `side`² rect). The lit picture of a rock depends on where it is
   * (relief, the star, the bloom of its own core), so "reads like ordinary rock" is asked
   * of the paint, which is the thing the iron flag decides.
   */
  const albedo = (x, y) =>
    page.evaluate(
      ([x, y, side]) => {
        const b64 = window.__world?.readAlbedo(Math.round(x - side / 2), Math.round(y - side / 2), side, side)
        if (!b64) return null
        const raw = atob(b64)
        const sum = [0, 0, 0]
        for (let i = 0; i < raw.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += raw.charCodeAt(i + c)
        const n = raw.length / 4
        return { r: sum[0] / n, g: sum[1] / n, b: sum[2] / n }
      },
      [x, y, pick.side],
    )
  const B = await frameOn(pick.rock, 'rock')
  const A = await frameOn(pick.iron, 'iron')
  /**
   * T23.20: the open-space control read **with the bloom off** (the renderer's dev switch,
   * asserted to hold). Un-ironed, the rock gains a core whose glow blooms into the space
   * beside it — (11, 7, 23) → (24, 15, 24) measured, the control "moved" — and that glow is
   * the flag's doing too. Without the shared post pass the control asks what it always
   * asked: nothing but the rock changed.
   */
  const openNoBloom = async () => {
    await page.evaluate(() => window.__world?.hideLayers(['bloom']))
    await frames(SETTLE_FRAMES)
    if (await page.evaluate(() => window.__world?.atmosphere()?.bloom !== false)) {
      throw new Error('the bloom is still drawing after hideLayers([bloom])')
    }
    const sky = await toScreen(page, pick.iron.ox, pick.iron.oy)
    const at = await toScreen(page, pick.iron.px, pick.iron.py)
    const w = Math.max(2, Math.round(pick.side * at.scale))
    const open = await samplePatch(page, { x: Math.round(sky.x - w / 2), y: Math.round(sky.y - w / 2), w, h: w })
    await page.evaluate(() => window.__world?.hideLayers([]))
    await frames(SETTLE_FRAMES)
    return open
  }
  const openA = await openNoBloom()
  log(`iron ${fmt(A.patch)} vs rock ${fmt(B.patch)}; open space beside the iron ${fmt(A.open)}`)
  const apart = colourDelta(A.patch, B.patch)
  if (apart < DISTINCT_MIN) {
    throw new Error(`iron ${fmt(A.patch)} is only ${apart.toFixed(1)} from rock ${fmt(B.patch)} (need ${DISTINCT_MIN})`)
  }
  if (lum(B.patch) - lum(A.patch) < DARKER_MIN) {
    throw new Error(
      `iron ${fmt(A.patch)} is not darker than rock ${fmt(B.patch)} by ${DARKER_MIN} ` +
        `(${lum(A.patch).toFixed(0)} vs ${lum(B.patch).toFixed(0)})`,
    )
  }

  // The minimap: both rocks have now been seen (the body stood beside each).
  const cell = async (wx, wy) =>
    page.evaluate(
      ([x, y, mw, mh]) => {
        const el = document.querySelector('[data-minimap="root"] canvas')
        if (!el) return null
        const dbg = window.__game.debug()
        const cx = Math.floor((x / dbg.mapW) * mw)
        const cy = Math.floor((y / dbg.mapH) * mh)
        const d = el.getContext('2d').getImageData(cx, cy, 1, 1).data
        return { r: d[0], g: d[1], b: d[2] }
      },
      [wx, wy, k.MINIMAP_W, k.MINIMAP_H],
    )
  await waitFor(() => (window.__game.minimap()?.explored ?? 0) > 0, null, 'the minimap never updated')
  // The minimap resamples its terrain on its own clock; wait until the iron's cell
  // is no longer the ordinary rock's colour or open space's — or fail saying so.
  const ironCell = await cell(pick.iron.x, pick.iron.y)
  const rockCell = await cell(pick.rock.x, pick.rock.y)
  const openCell = await cell(pick.iron.ox, pick.iron.oy)
  if (!ironCell || !rockCell || !openCell) throw new Error('no minimap canvas on the page')
  log(`minimap: iron ${fmt(ironCell)}, rock ${fmt(rockCell)}, open ${fmt(openCell)}`)
  if (colourDelta(ironCell, rockCell) < MINIMAP_DISTINCT_MIN || colourDelta(ironCell, openCell) < MINIMAP_DISTINCT_MIN) {
    throw new Error(
      `the minimap draws iron ${fmt(ironCell)} too near rock ${fmt(rockCell)} or open space ${fmt(openCell)}`,
    )
  }
  if (lum(ironCell) >= lum(rockCell)) {
    throw new Error(`the minimap's iron ${fmt(ironCell)} is not darker than its rock ${fmt(rockCell)}`)
  }

  const ironPaint = await albedo(pick.iron.px, pick.iron.py)
  const rockPaint = await albedo(pick.rock.px, pick.rock.py)
  if (!ironPaint || !rockPaint) throw new Error('no albedo to read — the lit terrain is not up')
  // The control frame: frame A's camera (still held), the rock no longer iron on this
  // client, and the patch's chunk rebaked by a 2 px carve beside it in the same chunk.
  const poked = await page.evaluate(
    ([ix, iy, px, py, side, chunk]) => {
      const core = window.__game.core
      core.setAsteroids(
        core.meta.asteroids.map((a) => ({ ...a, iron: a.x === ix && a.y === iy ? false : a.iron, coreHits: a.core_hits })),
      )
      const [cx, cy] = [Math.floor(px / chunk), Math.floor(py / chunk)]
      for (let d = 3 * side; d < 12 * side; d += 2) {
        for (const [x, y] of [[px + d, py], [px - d, py], [px, py + d], [px, py - d]]) {
          const inChunk = Math.floor(x / chunk) === cx && Math.floor(y / chunk) === cy
          if (inChunk && core.solidAt(x, y) && Math.hypot(x - ix, y - iy) > 0.4 * Math.hypot(px - ix, py - iy) + 60) {
            core.carve(x, y, 2)
            return [x, y]
          }
        }
      }
      return null
    },
    [pick.iron.x, pick.iron.y, Math.round(pick.iron.px), Math.round(pick.iron.py), pick.side, k.CHUNK_SIZE],
  )
  if (!poked) throw new Error('no solid pixel beside the patch in its chunk to rebake it by')
  await frames(SETTLE_FRAMES)
  const at = await toScreen(page, pick.iron.px, pick.iron.py)
  const sky = await toScreen(page, pick.iron.ox, pick.iron.oy)
  const w = Math.max(2, Math.round(pick.side * at.scale))
  const rect = (p) => ({ x: Math.round(p.x - w / 2), y: Math.round(p.y - w / 2), w, h: w })
  const C = { patch: await samplePatch(page, rect(at)), open: await samplePatch(page, rect(sky)) }
  await shot(`iron-asteroids-control${tag}`)
  log(`control frame (not iron): ${fmt(C.patch)}; open space ${fmt(C.open)} (poked ${poked})`)
  if (colourDelta(C.patch, A.patch) < DISTINCT_MIN) {
    throw new Error(
      `told it is not iron, the rock still reads ${fmt(C.patch)} (was ${fmt(A.patch)}) — the colour is not the iron flag's`,
    )
  }
  // T23.20: un-ironed, the rock gets a core (its disc is painted once the flag is off) and
  // the core's glow blooms over the patch — (94, 73, 49) lit against ordinary rock's
  // (78, 69, 71) on another rock elsewhere in the light, measured. So the lit leg above is
  // "the picture changed with the flag" and this one asks the paint: the un-ironed patch's
  // albedo is ordinary rock's, and not iron's.
  const freedPaint = await albedo(pick.iron.px, pick.iron.py)
  log(`paint: iron ${fmt(ironPaint)}, ordinary rock ${fmt(rockPaint)}, told not iron ${fmt(freedPaint)}`)
  if (colourDelta(ironPaint, rockPaint) < DISTINCT_MIN) {
    throw new Error(`premise: the iron's paint ${fmt(ironPaint)} is not apart from rock's ${fmt(rockPaint)}`)
  }
  if (colourDelta(freedPaint, ironPaint) < DISTINCT_MIN) {
    throw new Error(`told it is not iron, the paint still reads ${fmt(freedPaint)} (iron ${fmt(ironPaint)})`)
  }
  // Nearer ordinary rock's paint than iron's, not within a fixed distance of it: the paint
  // itself varies from rock to rock (its hash pattern, boulders and relief) — this rock's
  // freed patch read (88, 83, 90) against the other rock's (106, 100, 100), 27 apart, while
  // iron's sat 63 away. A flag that left the iron paint, or painted anything dark, is
  // nearer iron and fails here.
  const toRock = colourDelta(freedPaint, rockPaint)
  const toIron = colourDelta(freedPaint, ironPaint)
  if (!(toRock < toIron)) {
    throw new Error(
      `told it is not iron, the paint ${fmt(freedPaint)} is nearer iron's ${fmt(ironPaint)} (${toIron.toFixed(0)}) ` +
        `than ordinary rock's ${fmt(rockPaint)} (${toRock.toFixed(0)})`,
    )
  }
  const openC = await openNoBloom()
  log(`open space, bloom off: A ${fmt(openA)}, C ${fmt(openC)} (bloom on: ${fmt(A.open)} → ${fmt(C.open)})`)
  if (colourDelta(openC, openA) > SKY_AGREE_MAX) {
    throw new Error(`the control region moved between frames A and C (${fmt(openA)} → ${fmt(openC)}, bloom off)`)
  }
}
