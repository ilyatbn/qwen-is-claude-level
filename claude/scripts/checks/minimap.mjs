/**
 * T8.06 — the minimap reveals only what you have seen.
 *
 * The load-bearing claim is §A6's: the explored set **grows and never shrinks**,
 * and it starts far smaller than the map. A minimap that revealed everything at
 * once would pass any "is it drawn" check while destroying the feature.
 */
export default async function ({ page, shot, log }) {
  const mm = () => page.evaluate(() => window.__game.minimap())

  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(600)

  const start = await mm()
  if (!start) throw new Error('no minimap')
  log(`explored at start: ${start.explored}/${start.cells} cells`)

  // The whole point: you have seen a small part of the world, not all of it.
  if (start.explored === 0) throw new Error('standing still revealed nothing at all')
  if (start.explored > start.cells * 0.25) {
    throw new Error(
      `${start.explored}/${start.cells} cells explored before moving — the map is being given away`,
    )
  }

  // Walk, and the explored set must grow.
  await page.keyboard.down('d')
  await page.waitForTimeout(1500)
  await page.keyboard.up('d')
  await page.waitForTimeout(200)
  const walked = await mm()
  log(`after walking right: ${walked.explored}/${walked.cells}`)
  if (!(walked.explored > start.explored)) {
    throw new Error('walking revealed no new ground')
  }

  // And it never shrinks — walking back over old ground cannot un-reveal it.
  await page.keyboard.down('a')
  await page.waitForTimeout(1200)
  await page.keyboard.up('a')
  await page.waitForTimeout(200)
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
  // The five constants are read **inside the page**: `constants()` returns a
  // strict `Proxy` that throws on a name `constants_json` does not carry, and
  // serialising it across the CDP boundary would flatten that guard away,
  // leaving a missing constant as `undefined` and every derived row `NaN` —
  // the T20.15 failure the proxy exists to prevent.
  const K = await page.evaluate(() => {
    const c = window.__game.constants()
    return {
      MINIMAP_W: c.MINIMAP_W,
      MINIMAP_H: c.MINIMAP_H,
      SKY_MARGIN: c.SKY_MARGIN,
      SPACE_RIM_THICKNESS: c.SPACE_RIM_THICKNESS,
      PLAYER_H: c.PLAYER_H,
    }
  })
  for (const [k, v] of Object.entries(K)) {
    if (!Number.isFinite(v)) throw new Error(`constants().${k} is ${v}`)
  }

  // Classify every minimap cell by its **rendered colour**. The three terrain
  // colours are `Minimap.draw`'s own; anything else is `other`, which is what
  // the player's dot and the crate beacons are.
  const classify = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-minimap="root"] canvas')
      const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data
      const out = []
      for (let i = 0; i < el.width * el.height; i++) {
        const o = i * 4
        const k = `${d[o]},${d[o + 1]},${d[o + 2]}`
        out.push(
          k === '8,10,18' ? 'dark' : k === '122,104,78' ? 'solid' : k === '32,46,68' ? 'air' : 'other',
        )
      }
      return out
    })

  // Reveal the top of the arena, then its middle, and read the centre column.
  // **Two placements**, because `MINIMAP_REVEAL_R` is 260 world px — under two
  // minimap cells' worth of a Medium map's height — so one position cannot
  // light both the rim band and the space below it; and the second walks the
  // player's own dot out of the rows being read.
  async function probeColumn(gravity) {
    await page.evaluate((g) => window.__game.regenerate('12345', 'medium', g), gravity)
    await page.waitForTimeout(600)
    const dbg = await page.evaluate(() => window.__game.debug())
    const cellH = dbg.mapH / K.MINIMAP_H
    const top = K.SKY_MARGIN + K.SPACE_RIM_THICKNESS + K.PLAYER_H * 2
    await page.evaluate(([x, y]) => window.__game.place(x, y), [dbg.mapW / 2, top])
    await page.waitForTimeout(700)
    await page.evaluate(([x, y]) => window.__game.place(x, y), [dbg.mapW / 2, dbg.mapH / 2])
    await page.waitForTimeout(700)

    const cells = await classify()
    const col = Math.floor(K.MINIMAP_W / 2)
    const at = (row) => cells[row * K.MINIMAP_W + col]
    // The rows whose sample lands in the rim's band — derived, not counted off:
    // `resampleTerrain` samples row r at `(r + 0.5) * cellH`.
    const rimRows = []
    for (let r = 0; r < K.MINIMAP_H; r++) {
      const y = Math.floor((r + 0.5) * cellH)
      if (y >= K.SKY_MARGIN && y <= K.SKY_MARGIN + K.SPACE_RIM_THICKNESS) rimRows.push(r)
    }
    // And the band under it that must be open arena: clear of the rim, clear of
    // the player's dot, and inside what the first placement revealed.
    const belowRows = []
    const last = rimRows[rimRows.length - 1]
    for (let r = last + 5; r < last + 18; r++) belowRows.push(r)
    return { rim: rimRows.map(at), below: belowRows.map(at), rimRows, belowRows }
  }

  const space = await probeColumn('space')
  log(`space: rim rows ${space.rimRows.join(',')} read ${space.rim.join('/')}`)
  log(`space: rows ${space.belowRows[0]}-${space.belowRows.at(-1)} read ${space.below.join('/')}`)
  await shot('minimap-space')

  if (space.rim.every((c) => c === 'dark')) {
    throw new Error('the rim band was never revealed, so this probe cannot see anything')
  }
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
  // that paints a bar wherever it has not resampled.
  const land = await probeColumn('standard')
  log(`standard control: rim rows read ${land.rim.join('/')}`)
  if (land.rim.every((c) => c === 'dark')) {
    throw new Error('control: the same rows were never revealed, so the comparison is empty')
  }
  if (land.rim.includes('solid')) {
    throw new Error(
      `control: a standard map is solid in the rim band too (${land.rim.join('/')}) — ` +
        'this probe cannot tell the two modes apart',
    )
  }
  log('the minimap draws the space rim, and a standard map at the same rows does not')
}
