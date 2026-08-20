/**
 * T10.03 + T10.04: the title screen, its attract mode, and the menu.
 *
 * The attract mode is a smoke test of `game-core` that anyone can see (§B3), so
 * this asserts the simulation is genuinely running behind the title — bots
 * moving, terrain being destroyed — not merely that a canvas is not blank.
 */
export default async function ({ page, shot, log }) {
  await page.waitForFunction('window.__title.debug().mapW > 0', { timeout: 60_000 })

  const d = () => page.evaluate('window.__title.debug()')

  // --- the attract mode is really simulating ------------------------------
  const a = await d()
  if (a.bots.length < 2) throw new Error(`attract has ${a.bots.length} bots`)

  await page.waitForTimeout(4000)
  const b = await d()

  if (b.ticks <= a.ticks) {
    throw new Error(`the attract sim is not ticking: ${a.ticks} -> ${b.ticks}`)
  }
  // Displacement, not ticks: a sim that advances while every bot stands still
  // would satisfy a tick counter and prove nothing about game-core.
  const moved = b.bots.reduce((acc, bot, i) => {
    const was = a.bots[i]
    return acc + (was ? Math.hypot(bot.x - was.x, bot.y - was.y) : 0)
  }, 0)
  if (moved < 20) {
    throw new Error(`bots barely moved in 4 s (total ${moved.toFixed(1)} px)`)
  }
  log(`attract: ${b.ticks - a.ticks} ticks, bots moved ${moved.toFixed(0)} px total`)

  // Terrain can only lose pixels — nothing in the game puts rock back. Over
  // four seconds the bots may not have found a weapon yet, so this is an
  // invariant rather than evidence of a fight, and it is logged as such.
  if (b.solid > a.solid) {
    throw new Error(`solid pixels grew: ${a.solid} -> ${b.solid}`)
  }
  log(`attract: terrain ${a.solid} -> ${b.solid} px solid (never grows)`)

  await shot('title')

  // --- leaving the scene actually stops it (§A15) --------------------------
  //
  // The assertion is that no further ticks happen, not that `stop()` was
  // called. A counter that reports intent is how a whole milestone of this
  // project shipped a lightmap that computed and composited nothing.
  // The counter is scene-level and monotonic, so it survives teardown. The
  // control is that it is non-zero first: comparing 0 against 0 would pass
  // however the simulation behaved, which is what the first version of this
  // check did.
  const before = (await d()).ticks
  if (before <= 0) throw new Error('the attract sim never ticked, so stopping it proves nothing')

  await page.evaluate('window.__title.start()')
  await page.waitForFunction('window.__menu !== undefined', { timeout: 20_000 })
  const stopped1 = await d()
  await page.waitForTimeout(1500)
  const stopped2 = await d()
  if (stopped2.ticks !== stopped1.ticks) {
    throw new Error(
      `the attract sim kept running behind the menu: ${stopped1.ticks} -> ${stopped2.ticks}`,
    )
  }
  // Frozen ticks alone are weak evidence: Phaser stops calling `update` on a
  // scene that is no longer running, so the count would freeze whether or not
  // anything was released. Verified by falsification — deleting the SHUTDOWN
  // handler still passed that assertion.
  //
  // What proves the sim was actually released is that the handle is gone:
  // `attractTicks` is -1 only when the Attract object has been destroyed.
  if (stopped2.attractTicks !== -1) {
    throw new Error(
      `the attract sim is still allocated behind the menu (attractTicks ${stopped2.attractTicks})`,
    )
  }
  if (stopped2.running) throw new Error('the attract sim reports itself still running')
  log(
    `attract released: ticks frozen at ${stopped2.ticks} (ran ${before} before), handle freed`,
  )

  // --- the menu ------------------------------------------------------------
  const m = () => page.evaluate('window.__menu.debug()')
  const menu = await m()
  if (menu.screen !== 'menu') throw new Error(`menu opened on ${menu.screen}`)
  await shot('menu')

  // Map size is selectable and persists.
  await page.click('[data-scale="large"]')
  if ((await m()).scale !== 'large') throw new Error('map size did not change')

  // The join screen, and a bad code named locally rather than round-tripped.
  await page.click('#join')
  await page.fill('#code', 'ABCD0Z')
  await page.click('#go')
  const err = (await m()).error
  if (!err || !err.includes('0')) {
    throw new Error(`expected a message naming the bad character, got ${err}`)
  }
  // And it must keep what was typed, or fixing one character means retyping six.
  if ((await m()).code !== 'ABCD0Z') throw new Error('the typed code was cleared')
  log(`join: rejected locally — "${err}"`)
  await shot('menu-join')

  // Esc goes back, from anywhere.
  await page.keyboard.press('Escape')
  if ((await m()).screen !== 'menu') throw new Error('Esc did not go back')

  return 'ok'
}
