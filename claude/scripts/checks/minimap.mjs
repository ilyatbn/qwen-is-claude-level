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
}
