/**
 * T9.02 — `MapMeta.decorations` is actually drawn.
 *
 * The data has been generated since M1 and shipped since T6.04; the failure this
 * guards against is the one that already happened for eight milestones, which is
 * that nothing renders it and nothing notices.
 *
 * So the assertions are: props exist on screen, they are a *subset* of what the
 * map declared (a theme with no art for a kind skips it — `docs/50` §6), and
 * blowing up the ground takes the ones standing on it. That last one is the
 * control: a layer that draws props and never removes them would pass a
 * "are there decorations" check while leaving grass floating over craters.
 */
export default async function ({ page, shot, log }) {
  const decor = () => page.evaluate(() => window.__game.decorations())

  await page.evaluate(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(900)

  const start = await decor()
  log(`drawn ${start.count} of ${start.total} declared`)
  if (start.total === 0) throw new Error('the map declared no decorations at all')
  if (start.count === 0) {
    throw new Error(`${start.total} decorations declared and none drawn — the layer is not running`)
  }
  // Fewer is expected and correct; more would mean it invented some.
  if (start.count > start.total) {
    throw new Error(`drew ${start.count} from ${start.total} declared`)
  }

  // §A22: a screenshot that does not contain its subject is not evidence. The
  // first version of this shot framed an empty snowfield while 35 props stood
  // elsewhere on the map, and looked like a clean pass.
  const framed = await page.evaluate(() => {
    const g = window.__game
    const d = g.core.meta.decorations[0]
    if (!d) return null
    g.place(d.pos.x, d.pos.y - 40)
    return { x: d.pos.x, y: d.pos.y, kind: d.kind }
  })
  if (!framed) throw new Error('no decoration to frame')
  await page.waitForTimeout(700)
  log(`framed decoration kind ${framed.kind} at ${framed.x},${framed.y}`)

  // And prove it is on screen, not merely near the camera.
  const onScreen = await page.evaluate(() => {
    const g = window.__game
    const dbg = g.debug()
    const cam = dbg.camera
    const vis = dbg.visible
    return g.core.meta.decorations.filter(
      (d) =>
        Math.abs(d.pos.x - cam.x) < vis.w / 2 - 20 && Math.abs(d.pos.y - cam.y) < vis.h / 2 - 20,
    ).length
  })
  log(`decorations inside the viewport: ${onScreen}`)
  if (onScreen === 0) throw new Error('the screenshot would contain no decorations')

  await shot('decorations')

  // --- the control: destruction must remove them ----------------------------
  // Carve at each decoration in turn until one is destroyed, so the check does
  // not depend on a fixed coordinate happening to have a prop on it.
  const removed = await page.evaluate(() => {
    const g = window.__game
    const before = g.decorations().count
    const decos = g.core.meta.decorations.slice(0, 40)
    for (const d of decos) {
      g.carve(d.pos.x, d.pos.y, 60)
      if (g.decorations().count < before) return { before, after: g.decorations().count }
    }
    return { before, after: g.decorations().count }
  })
  log(`after carving over props: ${removed.before} -> ${removed.after}`)
  if (removed.after >= removed.before) {
    throw new Error('carving over decorations removed none — props will float over craters')
  }

  await shot('decorations-carved')
  log('props are drawn, bounded by what the map declared, and destroyed with the ground')
}
