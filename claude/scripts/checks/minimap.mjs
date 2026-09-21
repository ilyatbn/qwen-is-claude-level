/**
 * T8.06 — the minimap reveals only what you have seen.
 *
 * The load-bearing claim is §A6's: the explored set **grows and never shrinks**,
 * and it starts far smaller than the map. A minimap that revealed everything at
 * once would pass any "is it drawn" check while destroying the feature.
 *
 * ## T22.05C/F7: nothing here decides on a wall clock
 *
 * This file used to hold **eight** `waitForTimeout` calls and polled no
 * observable — the `smoke-shader` shape (`M22-FOUND-DEFECTS` #12) in a check
 * that was two days old. It failed in the safe direction (under load the reveal
 * had not happened and an assertion threw), but *"throws when the box is busy"*
 * is a gate that gates how busy the box is: four checks went red in the
 * 2026-09-21 gate from load alone and all four re-ran green on an idle box.
 *
 * Every sleep is now a `waitForFunction` on the condition that sleep was
 * waiting for, and **the wait carries the assertion's message** rather than
 * sitting in front of a second copy of it — a `throw` after a wait for the same
 * condition can never fire, and an assertion that cannot fail is the defect this
 * project is named after. Where that moved a message, the old assertion is gone
 * and a comment says where it went.
 *
 * The three terrain colours are **derived from the page** (`calibratePalette`)
 * instead of being hardcoded, so the control frame at the end cannot go vacuous
 * by a palette move in `client/src/ui/minimap.ts`.
 */
import { deadlineMs } from '../lib/deadline.mjs'

export default async function ({ page, shot, log }) {
  const mm = () => page.evaluate(() => window.__game.minimap())

  /**
   * One wait, one reason it can fail.
   *
   * `deadlineMs` refuses a deadline that is not a positive number of seconds,
   * which is the half of T20.15 that survives being computed from anything
   * else — a `NaN` timeout is *no* timeout, and a wait that cannot time out
   * cannot fail.
   */
  const waitFor = async (fn, arg, why, seconds = 20) => {
    try {
      await page.waitForFunction(fn, arg, { timeout: deadlineMs(seconds, why) })
    } catch (e) {
      if (String(e).includes('Timeout')) throw new Error(`${why} (waited ${seconds}s)`)
      throw e
    }
  }

  const playerX = async () => {
    const x = await page.evaluate(() => window.__game.debug().player?.x)
    if (!Number.isFinite(x)) throw new Error(`debug().player.x is ${String(x)}`)
    return x
  }

  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  // Was `waitForTimeout(600)` followed by `if (start.explored === 0) throw`.
  // The sleep was waiting for the first `Minimap.update` of the new map, and
  // "it never came" and "standing still revealed nothing" are the same failure,
  // so there is one of them now and it is the one that polls.
  await waitFor(
    () => (window.__game.minimap()?.explored ?? 0) > 0,
    null,
    'standing still revealed nothing at all — the new map’s minimap never updated',
  )

  const start = await mm()
  if (!start) throw new Error('no minimap')
  log(`explored at start: ${start.explored}/${start.cells} cells`)

  // The whole point: you have seen a small part of the world, not all of it.
  if (start.explored > start.cells * 0.25) {
    throw new Error(
      `${start.explored}/${start.cells} cells explored before moving — the map is being given away`,
    )
  }

  // Walk, and the explored set must grow. Was a 1500 ms hold; the hold now ends
  // when the thing it was held for has happened, and its failure is the
  // assertion that used to sit after it.
  await page.keyboard.down('d')
  await waitFor(
    (n) => window.__game.minimap().explored > n,
    start.explored,
    'walking right revealed no new ground',
  )
  const walked = await mm()
  const xWalked = await playerX()
  await page.keyboard.up('d')
  log(`after walking right: ${walked.explored}/${walked.cells}, x=${Math.round(xWalked)}`)

  // And it never shrinks — walking back over old ground cannot un-reveal it.
  // The wait is on the player moving back, which is what the 1200 ms bought;
  // the claim about the explored set is still asserted below, because nothing
  // in the wait implies it.
  await page.keyboard.down('a')
  await waitFor(
    (x) => window.__game.debug().player.x < x - 1,
    xWalked,
    'holding left moved the player nowhere, so nothing walked back over old ground',
  )
  await page.keyboard.up('a')
  const back = await mm()
  log(`after walking back: ${back.explored}/${back.cells}`)
  if (back.explored < walked.explored) {
    throw new Error(`explored area shrank: ${walked.explored} -> ${back.explored}`)
  }

  // It is actually on screen, and it is a canvas with real pixels in it.
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-minimap="root"] canvas')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const ctx = el.getContext('2d')
    const d = ctx.getImageData(0, 0, el.width, el.height).data
    const seen = new Set()
    for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`)
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      vw: window.innerWidth,
      vh: window.innerHeight,
      colours: seen.size,
    }
  })
  if (!box) throw new Error('the minimap canvas is not in the DOM')
  log(`minimap at ${box.x},${box.y} ${box.w}x${box.h}; ${box.colours} distinct colours`)
  if (box.x < 0 || box.y < 0 || box.x + box.w > box.vw || box.y + box.h > box.vh) {
    throw new Error('the minimap is off-viewport')
  }
  // Unexplored, solid and air are three different colours; a flat image means it
  // is drawing nothing useful.
  if (box.colours < 3) throw new Error(`the minimap is flat: only ${box.colours} colour(s)`)

  await shot('minimap')

  const off = await page.evaluate(() => window.__game.toggleMinimap())
  if (off !== false) throw new Error('M did not hide the minimap')
  const hidden = await page.evaluate(
    () => document.querySelector('[data-minimap="root"]').style.display,
  )
  if (hidden !== 'none') throw new Error('the minimap is still displayed after toggling off')
  await page.evaluate(() => window.__game.toggleMinimap())
  log('toggle hides and shows it')

  // ------------------------------------------------------------------ T22.05B
  //
  // **The minimap draws the *mode's* world, on rendered pixels.** The one
  // client claim T22.05B owes, and it is a pixel check rather than a data check
  // for `R13` point 2's reason: `resampleTerrain` point-samples `solidAt` once
  // per cell — about one sample per 15 world px on Medium — so a rim thinner
  // than a cell aliases into a dashed ring or vanishes. The mask can be perfect
  // and the picture empty; four shipped "I cannot see it" bugs were that.
  //
  // The claim is the one thing only this mode produces: at the map's horizontal
  // centre the minimap shows **a solid band near the top with open arena under
  // it** — a ceiling. A landscape map's sky band is air at that height on every
  // seed, which is what the control at the end measures.
  //
  // The constants are read **inside the page**: `constants()` returns a
  // strict `Proxy` that throws on a name `constants_json` does not carry, and
  // serialising it across the CDP boundary would flatten that guard away,
  // leaving a missing constant as `undefined` and every derived row `NaN` —
  // the T20.15 failure the proxy exists to prevent.
  const K = await page.evaluate(() => {
    const c = window.__game.constants()
    return {
      MINIMAP_W: c.MINIMAP_W,
      MINIMAP_H: c.MINIMAP_H,
      MINIMAP_REVEAL_R: c.MINIMAP_REVEAL_R,
      SKY_MARGIN: c.SKY_MARGIN,
      FLOOR_CRUST: c.FLOOR_CRUST,
      SPACE_RIM_THICKNESS: c.SPACE_RIM_THICKNESS,
      PLAYER_H: c.PLAYER_H,
    }
  })
  for (const [k, v] of Object.entries(K)) {
    if (!Number.isFinite(v)) throw new Error(`constants().${k} is ${v}`)
  }

  /** The rendered colour of one minimap cell, as `'r,g,b'`. */
  const colourAt = (cx, cy) =>
    page.evaluate(
      ([x, y]) => {
        const el = document.querySelector('[data-minimap="root"] canvas')
        const d = el.getContext('2d').getImageData(x, y, 1, 1).data
        return `${d[0]},${d[1]},${d[2]}`
      },
      [cx, cy],
    )

  /**
   * **T22.05C/F7: the three terrain colours, read out of the page.**
   *
   * They used to be the string literals `'8,10,18'`, `'122,104,78'` and
   * `'32,46,68'`, copied from `Minimap.draw`. A palette change there classifies
   * every cell as `other`, which makes `land.rim.includes('solid')` false and
   * the control frame below **pass while measuring nothing** — the exact
   * "a claim reported through something other than the thing it claims" shape
   * the control exists to prevent. `client/src/ui/minimap.ts` is not this
   * task's file and exposes no palette, so they are derived from rendered
   * pixels at three positions whose terrain class the map's own geometry
   * decides:
   *
   * - **unexplored** — the far corners, which no reveal has reached. Asserted
   *   to agree with each other and to be the modal colour, which the 25 % bound
   *   above guarantees for a fresh map.
   * - **air** — minimap row 0, whose sample lands inside `SKY_MARGIN`. Asserted.
   * - **solid** — the last row, whose sample lands inside the floor crust.
   *   Asserted.
   *
   * **Never a single pixel.** The first version of this read one cell at the
   * player's own column and came back with `255,224,102` — `Minimap.draw`'s
   * player dot, which it paints last, over the terrain. `solid` was then a
   * colour no terrain cell has, the whole rim classified as `other`, and the
   * check failed on the space assertion instead of on the palette. So each row
   * is read whole and the **commonest non-dark colour** wins, which a 3×3 dot
   * cannot: the count is asserted above that 3.
   *
   * Its own falsification: if any of those three reads the unexplored colour,
   * or if two of the three agree, it throws and names which.
   */
  async function calibratePalette() {
    await page.evaluate(() => window.__game.regenerate('12345', 'medium', 'standard'))
    await waitFor(
      () => (window.__game.minimap()?.explored ?? 0) > 0,
      null,
      'palette calibration: the minimap never updated after regenerate',
    )
    const dbg = await page.evaluate(() => window.__game.debug())
    const cellH = dbg.mapH / K.MINIMAP_H

    // Row 0 is sky and the last row is crust — derived from the map rect, and
    // checked, because a geometry change is what would silently mislabel the
    // two and hand the probe a palette with `solid` and `air` swapped.
    const skyY = 0.5 * cellH
    const crustY = (K.MINIMAP_H - 0.5) * cellH
    if (!(skyY < K.SKY_MARGIN)) {
      throw new Error(`palette: minimap row 0 samples y=${skyY.toFixed(1)}, below SKY_MARGIN`)
    }
    if (!(crustY > dbg.mapH - K.FLOOR_CRUST)) {
      throw new Error(
        `palette: the last minimap row samples y=${crustY.toFixed(1)}, above the floor crust`,
      )
    }

    // Unexplored: the corners, and the modal colour, which must be the same.
    const hist = await page.evaluate(() => {
      const el = document.querySelector('[data-minimap="root"] canvas')
      const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data
      const counts = new Map()
      for (let i = 0; i < d.length; i += 4) {
        const k = `${d[i]},${d[i + 1]},${d[i + 2]}`
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      return [...counts].sort((a, b) => b[1] - a[1])
    })
    const [modal, modalCount] = hist[0]
    const corners = await Promise.all([
      colourAt(0, 0),
      colourAt(K.MINIMAP_W - 1, 0),
      colourAt(0, K.MINIMAP_H - 1),
      colourAt(K.MINIMAP_W - 1, K.MINIMAP_H - 1),
    ])
    if (corners.some((c) => c !== modal)) {
      throw new Error(`palette: corners ${corners.join(' / ')} disagree with the modal ${modal}`)
    }
    if (!(modalCount > (K.MINIMAP_W * K.MINIMAP_H) / 2)) {
      throw new Error(
        `palette: the commonest colour covers only ${modalCount} of ` +
          `${K.MINIMAP_W * K.MINIMAP_H} cells, so it is not the unexplored one`,
      )
    }
    const dark = modal

    // The terrain colour of one whole row: the commonest colour that is not
    // `dark`, with its count, so the caller can refuse a winner small enough to
    // be the player's 3 px dot.
    const rowTerrain = (row) =>
      page.evaluate(
        ([r, d]) => {
          const el = document.querySelector('[data-minimap="root"] canvas')
          const px = el.getContext('2d').getImageData(0, r, el.width, 1).data
          const counts = new Map()
          for (let x = 0; x < el.width; x++) {
            const o = x * 4
            const k = `${px[o]},${px[o + 1]},${px[o + 2]}`
            if (k === d) continue
            counts.set(k, (counts.get(k) ?? 0) + 1)
          }
          return [...counts].sort((a, b) => b[1] - a[1])
        },
        [row, dark],
      )

    // `Minimap.draw` paints the local player as `fillRect(x-1, y-1, 3, 3)`, so
    // three cells of a row are its dot and nothing else is. A winner at or
    // under three is the dot, not the terrain.
    const DOT_CELLS = 3
    const terrainOf = async (row, what) => {
      const hist = await rowTerrain(row)
      if (hist.length === 0) throw new Error(`palette: row ${row} is entirely unexplored (${what})`)
      const [colour, count] = hist[0]
      if (!(count > DOT_CELLS)) {
        throw new Error(
          `palette: row ${row} (${what}) has no colour covering more than ${DOT_CELLS} ` +
            `cells — ${hist.map(([c, n]) => `${c}x${n}`).join(' ')} — so the commonest is ` +
            "the player's own dot, not the terrain",
        )
      }
      return colour
    }

    // At least this many revealed cells in the row before it is worth reading:
    // enough to outvote the dot. Derived from the reveal radius in cells, the
    // same conversion `minimap-math.ts::radiusToCells` makes.
    const revealCells = Math.max(1, Math.round((K.MINIMAP_REVEAL_R / dbg.mapW) * K.MINIMAP_W))
    if (!(revealCells > DOT_CELLS * 2)) {
      throw new Error(
        `palette: a reveal covers only ${revealCells} cells across, which cannot outvote ` +
          `the ${DOT_CELLS}-cell player dot`,
      )
    }
    const enough = DOT_CELLS * 2

    const waitForRowTerrain = (row, what) =>
      waitFor(
        ([r, d, n]) => {
          const el = document.querySelector('[data-minimap="root"] canvas')
          const px = el.getContext('2d').getImageData(0, r, el.width, 1).data
          let seen = 0
          for (let x = 0; x < el.width; x++) {
            const o = x * 4
            if (`${px[o]},${px[o + 1]},${px[o + 2]}` !== d) seen++
          }
          return seen >= n
        },
        [row, dark, enough],
        `palette: ${what} (row ${row}) was never revealed`,
      )

    // Air: stand in the sky band and read row 0.
    await page.evaluate(([x, y]) => window.__game.place(x, y), [dbg.mapW / 2, K.SKY_MARGIN / 2])
    await waitForRowTerrain(0, 'the sky row')
    const air = await terrainOf(0, 'sky')

    // Solid: stand in the floor crust and read the last row.
    await page.evaluate(
      ([x, y]) => window.__game.place(x, y),
      [dbg.mapW / 2, dbg.mapH - K.FLOOR_CRUST / 2],
    )
    await waitForRowTerrain(K.MINIMAP_H - 1, 'the crust row')
    const solid = await terrainOf(K.MINIMAP_H - 1, 'crust')

    const pal = { dark, solid, air }
    const seen = new Set([dark, solid, air])
    if (seen.size !== 3) {
      throw new Error(
        `palette: dark=${dark} solid=${solid} air=${air} are not three distinct colours, ` +
          'so classifying a cell decides nothing',
      )
    }
    log(`palette read from the page: dark=${dark} solid=${solid} air=${air}`)
    return pal
  }

  const PAL = await calibratePalette()

  // Classify every minimap cell by its **rendered colour**, against the palette
  // just read out of the page. Anything else is `other`, which is what the
  // player's dot and the crate beacons are.
  const classify = () =>
    page.evaluate((pal) => {
      const el = document.querySelector('[data-minimap="root"] canvas')
      const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data
      const out = []
      for (let i = 0; i < el.width * el.height; i++) {
        const o = i * 4
        const k = `${d[o]},${d[o + 1]},${d[o + 2]}`
        out.push(k === pal.dark ? 'dark' : k === pal.solid ? 'solid' : k === pal.air ? 'air' : 'other')
      }
      return out
    }, PAL)

  /** The rows whose sample lands in the rim's band, and the open band under it. */
  function rowsFor(mapH) {
    const cellH = mapH / K.MINIMAP_H
    // Derived, not counted off: `resampleTerrain` samples row r at
    // `(r + 0.5) * cellH`.
    const rimRows = []
    for (let r = 0; r < K.MINIMAP_H; r++) {
      const y = Math.floor((r + 0.5) * cellH)
      if (y >= K.SKY_MARGIN && y <= K.SKY_MARGIN + K.SPACE_RIM_THICKNESS) rimRows.push(r)
    }
    const belowRows = []
    const last = rimRows[rimRows.length - 1]
    for (let r = last + 5; r < last + 18; r++) belowRows.push(r)
    return { rimRows, belowRows }
  }

  /**
   * Wait until at least one of `rows` at the centre column has been revealed.
   *
   * This is what the two 700 ms sleeps after `place` were for, and it is also
   * where the old `rim.every(c => 'dark')` assertions have gone: a sleep
   * followed by a throw on the same condition reports "not revealed **yet**" as
   * "not revealed", which is the load failure. Polling reports it as what it is.
   */
  const waitForRows = (rows, col, why) =>
    waitFor(
      ([rs, c, d]) => {
        const el = document.querySelector('[data-minimap="root"] canvas')
        const px = el.getContext('2d').getImageData(0, 0, el.width, el.height).data
        return rs.some((r) => {
          const o = (r * el.width + c) * 4
          return `${px[o]},${px[o + 1]},${px[o + 2]}` !== d
        })
      },
      [rows, col, PAL.dark],
      why,
    )

  // Reveal the top of the arena, then its middle, and read the centre column.
  // **Two placements**, because `MINIMAP_REVEAL_R` is under two minimap cells'
  // worth of a Medium map's height — so one position cannot light both the rim
  // band and the space below it; and the second walks the player's own dot out
  // of the rows being read.
  async function probeColumn(gravity) {
    await page.evaluate((g) => window.__game.regenerate('12345', 'medium', g), gravity)
    await waitFor(
      () => (window.__game.minimap()?.explored ?? 0) > 0,
      null,
      `${gravity}: the minimap never updated after regenerate`,
    )
    const dbg = await page.evaluate(() => window.__game.debug())
    const { rimRows, belowRows } = rowsFor(dbg.mapH)
    const col = Math.floor(K.MINIMAP_W / 2)
    const top = K.SKY_MARGIN + K.SPACE_RIM_THICKNESS + K.PLAYER_H * 2

    await page.evaluate(([x, y]) => window.__game.place(x, y), [dbg.mapW / 2, top])
    await waitForRows(
      rimRows,
      col,
      `${gravity}: the rim band (rows ${rimRows.join(',')}) was never revealed, so this ` +
        'probe cannot see anything',
    )
    await page.evaluate(([x, y]) => window.__game.place(x, y), [dbg.mapW / 2, dbg.mapH / 2])
    await waitForRows(
      belowRows,
      col,
      `${gravity}: rows ${belowRows[0]}-${belowRows.at(-1)} under the rim were never revealed`,
    )

    const cells = await classify()
    const at = (row) => cells[row * K.MINIMAP_W + col]
    return { rim: rimRows.map(at), below: belowRows.map(at), rimRows, belowRows }
  }

  const space = await probeColumn('space')
  log(`space: rim rows ${space.rimRows.join(',')} read ${space.rim.join('/')}`)
  log(`space: rows ${space.belowRows[0]}-${space.belowRows.at(-1)} read ${space.below.join('/')}`)
  await shot('minimap-space')

  // The "never revealed" guards are the two waits above; reaching here means
  // both bands are on the canvas, so these two say what is drawn there.
  if (!space.rim.includes('solid')) {
    throw new Error(
      `the space rim is not on the minimap: rows ${space.rimRows.join(',')} read ${space.rim.join('/')}`,
    )
  }
  if (!space.below.includes('air')) {
    throw new Error(
      `no open arena under the rim: rows ${space.belowRows.join(',')} read ${space.below.join('/')}`,
    )
  }

  // **The control frame**, and it is the falsification written out: the same
  // probe, the same seed, standard gravity. The band that is rim in space is
  // sky there — so `solid` in it is a claim only the space map can satisfy.
  // Without this, "there is a solid cell near the top" would pass for a minimap
  // that paints a bar wherever it has not resampled. Its own "the rows were
  // never revealed" half is `probeColumn`'s wait, which fails naming the mode.
  const land = await probeColumn('standard')
  log(`standard control: rim rows read ${land.rim.join('/')}`)
  if (land.rim.includes('solid')) {
    throw new Error(
      `control: a standard map is solid in the rim band too (${land.rim.join('/')}) — ` +
        'this probe cannot tell the two modes apart',
    )
  }
  log('the minimap draws the space rim, and a standard map at the same rows does not')
}
