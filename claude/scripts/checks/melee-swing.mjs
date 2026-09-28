/**
 * `melee-swing` — your own swing and throw play on the frame you use them, predicted — no round trip — and a use the
 * server would refuse plays nothing.
 *
 * T23.14E: the prediction is the predicted sim's (`Core.predictUse`: the server's `World::fire` / `World::quick_throw`
 * checks through `PlayerState::try_fire_slot`, on the predicted player), not T23.09D's TypeScript copy of the rules.
 *
 * A networked match (one human, `DEV_LOADOUT`: a shovel, a bazooka, an smg, molotovs …), a short round. Each use is
 * sent and the local figure's action read **in one page turn** — no server message can arrive inside it:
 * 1. the shovel: a melee swing at t 0 — the swing latency is zero frames (the server's `melee` echo, what T23.14D
 *    swung on, is measured and reported as the round trip it would have cost);
 * 2. again inside its cooldown: not restarted;  3. the server's `melee` arrives: not restarted by it;
 * 4. after the cooldown: swings again;
 * 5. the bazooka, then at once the shovel — inside the **one per-player cooldown** the bazooka started: no swing;
 * 6. `E` (§C11 quick-throw) after that cooldown: a throw at t 0, of the molotov; again at once: not restarted;
 * 7. the round over (`ended`): the shovel swings nothing.
 * T23.14F F2, reconciled with the server (`look/actors/pendingUses.ts`): 8. a use the mirror refused and the server
 * took swings late, on the server's echo; 9. a prediction the server never confirms swings once and is dropped.
 * Control: firing the smg swings nothing.
 */
import { startStack, freePort, enterBattle, selectWeapon, tally, sleep } from './harness.mjs'

const ROUND_S = 45
const t = tally('melee-swing')
const stack = await startStack({
  port: await freePort(),
  label: 'melee-swing',
  env: {
    FIXED_SEED: '4242',
    ROUND_SECONDS: String(ROUND_S),
    DEV_WARMUP_SECONDS: '2',
    BOT_COUNT: '0',
    DEV_LOADOUT: '1',
    DEV_START_HEALTH: '100000',
    WEATHER: 'off',
  },
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
  // Cooldowns from the registry the client reads (`item_registry_json`), not copies.
  const registry = await page.evaluate(() => JSON.parse(window.__game.core.itemRegistryJson()))
  const cd = (key) => {
    const c = registry.find((d) => d.key === key)?.cooldown
    if (typeof c !== 'number' || !(c > 0)) throw new Error(`the registry gives ${key} no cooldown (${c})`)
    return c
  }
  const slotOf = async (key) => {
    const slots = await page.evaluate(() => window.__game.debug().slots)
    const s = slots.find((x) => x.key === key)
    if (!s) throw new Error(`${key} is not in the bag: ${slots.filter((x) => x.key).map((x) => x.key).join(' ')}`)
    return s.slot
  }
  const use = (quick) => page.evaluate((q) => {
    const g = window.__game
    if (q) g.quickThrow()
    else g.fire()
    const d = g.debug()
    return { action: d.localAction, lastUse: d.observed.lastUse }
  }, quick)

  // Control: a gun swings nothing.
  await selectWeapon(page, 'smg')
  await frames(3)
  const gun = await use(false)
  if (gun.action === null) t.ok(`control: firing the smg swings nothing (predicted use ${JSON.stringify(gun.lastUse)})`)
  else t.fail(`control: the smg swung the figure: ${JSON.stringify(gun)}`)

  await selectWeapon(page, 'shovel')
  await sleep(Math.ceil(cd('smg') * 1000) + 100)
  const before = await swingsHeard()
  // 1. Predicted: the swing is on the figure in the same page turn the request was sent in.
  const sentAt = await page.evaluate(() => performance.now())
  const first = await use(false)
  const heardYet = await swingsHeard()
  if (first.action?.kind === 'melee' && first.action.t === 0 && first.lastUse?.key === 'shovel') {
    t.ok(`the swing starts in the turn the request is sent: latency 0 frames (${JSON.stringify(first)}; server melee heard ${heardYet - before} so far)`)
  } else t.fail(`no swing on the frame of the use: ${JSON.stringify(first)}`)
  // 2. Inside the cooldown: a second request does not restart it.
  await frames(4)
  const { mid, again } = await page.evaluate(() => {
    const mid = window.__game.debug().localAction
    window.__game.fire()
    return { mid, again: window.__game.debug().localAction }
  })
  // T23.14F: on a loaded box four frames can outlast the swing itself (`MELEE_S`, 0.28 s): it was `null -> null`
  // once in a 4-wide batch (gate-t2318-B1.txt) — ended, and not restarted, which is the claim. What decides the leg is
  // that the use is inside the cooldown (the elapsed time, measured) and that the action was not restarted.
  const inside = await page.evaluate((t0) => performance.now() - t0, sentAt)
  const kept = mid === null ? again === null : again !== null && again.t === mid.t && again.t > 0
  if (inside >= cd('shovel') * 1000) t.fail(`the box was too slow to test inside the cooldown: ${inside.toFixed(0)} ms elapsed`)
  else if (kept) t.ok(`a use inside the cooldown swings nothing (${inside.toFixed(0)} ms in; ${mid ? `t ${mid.t.toFixed(3)} kept` : 'the swing had ended, and stayed ended'})`)
  else t.fail(`a use inside the cooldown restarted the swing: ${JSON.stringify(mid)} -> ${JSON.stringify(again)}`)
  // 3. The echo: once the server's melee is heard, the swing was not restarted by it. Its arrival is the round trip
  // the swing would have waited for (T23.14D's echo-driven swing).
  const echoAt = await page.waitForFunction((n) => {
    const d = window.__game.debug()
    return (d.swings ?? d.observed?.swings ?? 0) > n ? performance.now() : false
  }, before, { timeout: 10_000 }).then((h) => h.jsonValue()).catch(() => null)
  const afterEcho = await page.evaluate(() => window.__game.debug().localAction)
  if (echoAt === null) t.fail('the server never sent the melee (the swing was not a real use)')
  else if (afterEcho === null || afterEcho.t > 0) t.ok(`the server's melee arrived ${(echoAt - sentAt).toFixed(0)} ms after the use (the round trip an echo-driven swing waits); the swing was not restarted by it (${JSON.stringify(afterEcho)})`)
  else t.fail(`the server's melee restarted the swing: ${JSON.stringify(afterEcho)}`)
  // 4. Control: after the cooldown, the shovel swings again.
  await sleep(Math.ceil(cd('shovel') * 1000) + 200)
  const later = await use(false)
  if (later.action?.kind === 'melee' && later.action.t === 0) t.ok('after the cooldown the shovel swings again')
  else t.fail(`after the cooldown the shovel did not swing: ${JSON.stringify(later)}`)

  // 5. One per-player cooldown: the bazooka, then at once the shovel — refused, no swing. All in one page turn, so the
  // shovel's use is inside the bazooka's cooldown however slow the box.
  await sleep(Math.ceil(cd('shovel') * 1000) + 200)
  const [bz, sh] = [await slotOf('bazooka'), await slotOf('shovel')]
  const shared = await page.evaluate(([b, s]) => {
    const g = window.__game
    g.selectSlot(b)
    g.fire()
    const bazooka = g.debug().observed.lastUse
    const bazookaAction = g.debug().localAction
    g.selectSlot(s)
    g.fire()
    return { bazooka, bazookaAction, shovel: g.debug().observed.lastUse, action: g.debug().localAction }
  }, [bz, sh])
  if (shared.bazooka?.key === 'bazooka' && shared.shovel?.key === null && !(shared.action?.t === 0 && shared.action?.kind === 'melee')) {
    t.ok(`the shovel inside the bazooka's cooldown swings nothing (bazooka ${JSON.stringify(shared.bazooka)}, shovel ${JSON.stringify(shared.shovel)}, action ${JSON.stringify(shared.action)})`)
  } else t.fail(`the shared cooldown did not refuse the shovel: ${JSON.stringify(shared)}`)

  // 6. `E`: the quick-throw animates your own figure through the same predicted path.
  await sleep(Math.ceil(cd('bazooka') * 1000) + 200)
  const thrown = await use(true)
  if (thrown.action?.kind === 'throw' && thrown.action.t === 0 && thrown.lastUse?.key === 'molotov') {
    t.ok(`E throws on the frame it is pressed (${JSON.stringify(thrown)})`)
  } else t.fail(`E did not throw on its frame: ${JSON.stringify(thrown)}`)
  await frames(3)
  const { m2, e2 } = await page.evaluate(() => {
    const m2 = window.__game.debug().localAction
    window.__game.quickThrow()
    return { m2, e2: window.__game.debug().localAction }
  })
  if (m2 && e2 && e2.t === m2.t && e2.t > 0) t.ok(`E inside the cooldown throws nothing (t ${m2.t.toFixed(3)} kept)`)
  else t.fail(`E inside the cooldown restarted the throw: ${JSON.stringify(m2)} -> ${JSON.stringify(e2)}`)

  // 8. T23.14F F2 — **a use the mirror refused and the server took swings late, on the server's echo.** The mirror's
  // bag is emptied (`desyncMirror('empty')`: a pickup it has not heard of, T23.14F's case (c)); the shovel's use is
  // predicted refused — no swing on its frame — and the server's `melee` for it swings the figure when it lands.
  await sleep(Math.ceil(cd('molotov') * 1000) + 200)
  await page.evaluate((s) => window.__game.selectSlot(s), sh)
  await frames(3)
  const fn = await page.evaluate(() => {
    const g = window.__game
    g.desyncMirror('empty')
    const before = g.debug().observed
    g.fire()
    const d = g.debug()
    return { key: d.observed.lastUse?.key ?? null, action: d.localAction, swings: before.localSwings, late: before.pendingUses.late }
  })
  const lateAt = await page.waitForFunction((n) => {
    const d = window.__game.debug()
    return d.observed.pendingUses.late > n ? { action: d.localAction, swings: d.observed.localSwings } : false
  }, fn.late, { timeout: 10_000 }).then((h) => h.jsonValue()).catch(() => null)
  await page.evaluate(() => window.__game.desyncMirror('server'))
  if (fn.key !== null || (fn.action?.kind === 'melee' && fn.action.t === 0)) t.fail(`the emptied mirror still predicted the shovel: ${JSON.stringify(fn)}`)
  else if (lateAt === null) t.fail(`the server's echo of a use the mirror refused never swung the figure (${JSON.stringify(fn)})`)
  else if (lateAt.action?.kind === 'melee' && lateAt.swings === fn.swings + 1) {
    t.ok(`a use the mirror refused swings late on the server's melee (predicted ${fn.key}; on the echo ${JSON.stringify(lateAt)})`)
  } else t.fail(`the late echo did not swing the figure once: ${JSON.stringify({ fn, lateAt })}`)

  // 9. T23.14F F2 — **a prediction the server never confirms is dropped, and never swings twice.** The server fires
  // the smg (selected there); the mirror is told the shovel is selected (`desyncMirror({slot})`: an overwritten
  // selection, case (d)). The predicted shovel swings on its frame; no `melee` comes; past the bound the prediction
  // is dropped — one swing in all.
  await sleep(Math.ceil(cd('shovel') * 1000) + 200)
  await selectWeapon(page, 'smg')
  await frames(3)
  const fp = await page.evaluate((s) => {
    const g = window.__game
    g.desyncMirror({ slot: s })
    const before = g.debug().observed
    g.fire()
    const d = g.debug()
    return { key: d.observed.lastUse?.key ?? null, action: d.localAction, swings0: before.localSwings, swings1: d.observed.localSwings, dropped: before.pendingUses.dropped, bound: d.observed.pendingUses.boundMs }
  }, sh)
  await sleep(Math.ceil(fp.bound) + 300)
  const fpAfter = await page.evaluate(() => {
    const g = window.__game
    g.desyncMirror('server')
    g.fire() // the smg, agreed again: it expires what has waited past the bound, and swings nothing (the control).
    const o = g.debug().observed
    return { swings: o.localSwings, pending: o.pendingUses }
  })
  if (fp.key === 'shovel' && fp.action?.kind === 'melee' && fp.swings1 === fp.swings0 + 1 &&
      fpAfter.swings === fp.swings1 && fpAfter.pending.dropped === fp.dropped + 1 && fpAfter.pending.waiting === 0) {
    t.ok(`an unconfirmed prediction swung once and was dropped after ${fp.bound.toFixed(0)} ms (${JSON.stringify(fpAfter)})`)
  } else t.fail(`the unconfirmed prediction: ${JSON.stringify({ fp, fpAfter })}`)

  // 7. After the bell: nothing swings.
  const ended = await page.waitForFunction(() => window.__game.debug().phase === 'ended', null, { timeout: (ROUND_S + 30) * 1000 })
    .then(() => true).catch(() => false)
  if (!ended) t.fail('the round never ended')
  else {
    await sleep(Math.ceil(cd('molotov') * 1000) + 200)
    await page.evaluate((s) => window.__game.selectSlot(s), sh)
    const over = await use(false)
    if (over.lastUse?.key === null && !(over.action?.kind === 'melee' && over.action.t === 0)) t.ok(`after the round bell the shovel swings nothing (${JSON.stringify(over)})`)
    else t.fail(`the shovel swung after the round ended: ${JSON.stringify(over)}`)
  }
  if (pageErrors.length) t.fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
} catch (e) {
  t.fail(`threw: ${e?.stack ?? e}`)
}
await t.finish(() => stack.close())
