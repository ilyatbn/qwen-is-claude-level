/**
 * `melee-swing` — T23.09D: your own swing plays on the frame you swing, predicted — no round trip — and a use the
 * server would refuse does not swing.
 *
 * A networked match (one human, `DEV_LOADOUT`: a shovel in slot 1, a melee weapon). In one page turn — no server message can arrive
 * inside it — the fire request is sent and the local figure's action read: it is a melee swing at t 0 (T23.14D played
 * it only on the server's `melee` echo, a round trip later; before that, on the raw click, refused or not).
 * Then, still inside the shovel's cooldown, a second request: the swing is not restarted (a refused use swings nothing).
 * The server's `melee` for the first arrives (counted): the swing is not restarted by it either. Controls: with a gun
 * selected, a request swings nothing; after the cooldown, the shovel swings again.
 */
import { startStack, freePort, enterBattle, selectWeapon, tally, sleep } from './harness.mjs'

const t = tally('melee-swing')
const stack = await startStack({
  port: await freePort(),
  label: 'melee-swing',
  env: { FIXED_SEED: '4242', ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1', DEV_START_HEALTH: '100000', WEATHER: 'off' },
})
try {
  const { page, pageErrors } = await stack.openClient({ name: 'ana' })
  await enterBattle(page, { waitPlaying: true, label: 'melee-swing' })
  const swingsHeard = () => page.evaluate(() => {
    const d = window.__game.debug()
    return d.swings ?? d.observed?.swings ?? 0
  })
  const frames = (n) => page.evaluate((k) => new Promise((r) => {
    let i = 0
    const f = () => (++i >= k ? r() : requestAnimationFrame(f))
    requestAnimationFrame(f)
  }), n)
  // The shovel's cooldown from the registry the client reads (`item_registry_json`), not a copy.
  const cooldown = await page.evaluate(() => JSON.parse(window.__game.core.itemRegistryJson()).find((d) => d.key === 'shovel')?.cooldown)
  if (typeof cooldown !== 'number' || !(cooldown > 0)) throw new Error(`the registry gives the shovel no cooldown (${cooldown})`)

  // Control: a gun swings nothing.
  await selectWeapon(page, 'smg')
  await frames(3)
  const gun = await page.evaluate(() => {
    window.__game.fire()
    return window.__game.debug().localAction
  })
  if (gun === null) t.ok('control: firing the smg swings nothing')
  else t.fail(`control: the smg swung the figure: ${JSON.stringify(gun)}`)

  await selectWeapon(page, 'shovel')
  await frames(3)
  const before = await swingsHeard()
  // 1. Predicted: the swing is on the figure in the same page turn the request was sent in.
  const first = await page.evaluate(() => {
    window.__game.fire()
    return window.__game.debug().localAction
  })
  const heardYet = await swingsHeard()
  if (first?.kind === 'melee' && first.t === 0) t.ok(`the swing starts in the turn the request is sent (${JSON.stringify(first)}; server melee heard ${heardYet - before} so far)`)
  else t.fail(`no swing on the frame of the use: ${JSON.stringify(first)}`)
  // 2. Inside the cooldown: a second request does not restart it.
  await frames(4)
  // Read and fired in one page turn, so no frame advances the swing in between.
  const { mid, again } = await page.evaluate(() => {
    const mid = window.__game.debug().localAction
    window.__game.fire()
    return { mid, again: window.__game.debug().localAction }
  })
  if (mid && again && again.t === mid.t && again.t > 0) t.ok(`a use inside the cooldown swings nothing (t ${mid.t.toFixed(3)} kept)`)
  else t.fail(`a use inside the cooldown restarted the swing: ${JSON.stringify(mid)} -> ${JSON.stringify(again)}`)
  // 3. The echo: once the server's melee is heard, the swing was not restarted by it.
  const echoed = await page.waitForFunction((n) => {
    const d = window.__game.debug()
    return (d.swings ?? d.observed?.swings ?? 0) > n
  }, before, { timeout: 10_000 }).then(() => true).catch(() => false)
  const afterEcho = await page.evaluate(() => window.__game.debug().localAction)
  if (!echoed) t.fail('the server never sent the melee (the swing was not a real use)')
  else if (afterEcho === null || afterEcho.t > 0) t.ok(`the server's melee arrived; the swing was not restarted by it (${JSON.stringify(afterEcho)})`)
  else t.fail(`the server's melee restarted the swing: ${JSON.stringify(afterEcho)}`)
  // Control: after the cooldown, the shovel swings again.
  await sleep(Math.ceil(cooldown * 1000) + 200)
  const later = await page.evaluate(() => {
    window.__game.fire()
    return window.__game.debug().localAction
  })
  if (later?.kind === 'melee' && later.t === 0) t.ok('after the cooldown the shovel swings again')
  else t.fail(`after the cooldown the shovel did not swing: ${JSON.stringify(later)}`)
  if (pageErrors.length) t.fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
} catch (e) {
  t.fail(`threw: ${e?.stack ?? e}`)
}
await t.finish(() => stack.close())
