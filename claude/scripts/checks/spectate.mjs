#!/usr/bin/env node
/**
 * `spectate` — T23.27 (`docs/78` §A1): **watch a match with no body, Tab to switch whom you watch.**
 *
 * One real server, a full room of bots plus one player (ana, the control) and one spectator (`?spectate=1`), joined
 * into the same lobby by quick match; ana starts the round.
 *
 * 1. **No body, both ends.** The spectator's own id is absent from its snapshots (`debug().playerIds`) and its core
 *    holds no local player (`debug().player` null); the control — ana's id — is present in the same list, and ana's own
 *    client has a body.
 * 2. **The camera is on player A.** `debug().watching` names A (a living player); the viewpoint the scene uses
 *    (`viewAt`) is where A is drawn (`drawnPlayers`), and the camera rig's centre is on A, clamped to the map as the rig
 *    clamps (`cameraRig-math.ts::clampCenter`: half a view from each edge). Both ends: the state names A, the camera is
 *    there.
 * 3. **Tab moves it to B; Shift+Tab back to A.** After Tab `watching` is a different living player B, the viewpoint is
 *    B's drawn place and the camera centre moved to B — and away from A, when the two stand far enough apart for that
 *    to mean anything (Tab is pressed until such a B comes up; the distance is logged). Shift+Tab returns to A.
 * 4. The spectate line names the watched player — **by name**, B's after Tab and A's after Shift+Tab (T23.27C F5a) —
 *    and the HUD's health is the watched player's: B's snapshot health, and not A's when theirs differ (F5b; logged when
 *    they do not, since then the leg cannot tell them apart). No page errors. A screenshot of the view.
 * 5. **The control:** ana's Tab, in the same match, toggles her scoreboard and steps no camera.
 * 6. **Alive is the watched player's** (T23.27C F9): the watcher watches ana, ana is put below the map (`debugPlace`,
 *    the void death), and while the camera lingers on her death the watcher's `death.meAlive` is false — it read its
 *    own seat's row, which a spectator never has, and stayed true. The control: true while she was alive.
 *
 * **What the viewpoint leg (`dv <= VIEW_TOL`) can and cannot show** (T23.27C F5c): `viewAt` and `drawnPlayers` come
 * from the same `sampled` map in one frame (`GameScene.update` → `viewer(sampled)` / `renderRemotes(sampleAt, sampled)`),
 * so it is close to a tautology. The camera-centre leg (`dc <= CAMERA_TOL`) is the real evidence that the view moved.
 *
 *   node scripts/checks/spectate.mjs
 */
import { startStack, enterBattle, freePort, tally, sleep } from './harness.mjs'

const { fail, ok, finish } = tally('spectate')

/** The rig eases toward its target; after this long it is settled on a walking body (lerp per frame, measured). */
const SETTLE_MS = 1500
/** How far the rig's centre may sit from the clamped target once settled: the lag behind a body at walking pace. */
const CAMERA_TOL = 60
/** The viewpoint is the drawn body: the same sample, so within a pixel (container rounding). */
const VIEW_TOL = 2
/** Two players are "far apart" for the camera leg when the clamped camera targets differ by this much (world px). */
const APART = 250

const stack = await startStack({
  port: await freePort(),
  label: 'spectate',
  // Nobody dies (`DEV_START_HEALTH`): the Tab order is the living players', and a death between presses would move it.
  // `DEV_PROBE` for leg 6's `debugPlace`.
  env: { BOT_COUNT: '3', FIXED_SEED: '4242', WEATHER: 'off', DEV_WARMUP_SECONDS: '2', ROUND_SECONDS: '300', DEV_START_HEALTH: '100000', DEV_PROBE: '1' },
})
let watcher = null
let ana = null
const teardown = async () => {
  for (const c of [watcher, ana]) if (c?.pageErrors?.length) fail(`${c.name}: page errors: ${c.pageErrors.join(' | ')}`)
  await stack.close()
}
try {
  watcher = await stack.openClient({ name: 'watcher', query: '&spectate=1' })
  ana = await stack.openClient({ name: 'ana' })
  await enterBattle(ana.page, { waitPlaying: true, expectPlayers: 4, label: 'spectate/ana' })
  const w = watcher.page
  await w.waitForFunction(
    () => {
      const d = window.__game.debug()
      return d.phase === 'playing' && d.ready && d.watching !== null && d.viewAt !== null
    },
    null,
    { timeout: 60_000 },
  )

  // ------------------------------------------------------------------ 1. no body, both ends
  const d0 = await w.evaluate(() => window.__game.debug())
  const anaMe = await ana.page.evaluate(() => window.__game.debug().me)
  const anaBody = await ana.page.evaluate(() => window.__game.debug().player)
  console.log(`  watcher id ${d0.me}, snapshot ids ${JSON.stringify(d0.playerIds)}; ana id ${anaMe}`)
  if (d0.spectating !== true) fail('the watcher is not in spectate mode')
  // T23.27C F5d: a `-1` would pass "not in its own snapshot" vacuously.
  if (!(d0.me >= 0)) fail(`the watcher has no seat (me ${d0.me}) — the no-body leg below proves nothing`)
  if (d0.playerIds.includes(d0.me)) fail(`the spectator's id ${d0.me} is in its own snapshot — it has a body`)
  else ok(`no body: the spectator's id ${d0.me} is not among the ${d0.playerIds.length} players`)
  if (!d0.playerIds.includes(anaMe)) fail(`the control: ana's id ${anaMe} is not in the spectator's snapshot (not the same room?)`)
  else ok(`control: ana (${anaMe}), an unflagged join, is in the same snapshot`)
  if (d0.player !== null) fail(`the spectator's core holds a local player: ${JSON.stringify(d0.player)}`)
  if (!anaBody) fail("the control: ana's core holds no local player")

  // ------------------------------------------------------------------ 2. the camera is on A
  const read = () => w.evaluate(() => {
    const d = window.__game.debug()
    return {
      watching: d.watching,
      viewAt: d.viewAt,
      centre: d.cameraCentre,
      drawn: d.drawnPlayers,
      view: { w: d.worldView.width, h: d.worldView.height },
      mapW: d.mapW,
      mapH: d.mapH,
      steps: d.watchSteps,
      line: document.getElementById('spectate-line')?.textContent ?? null,
      hud: document.getElementById('game-hud')?.textContent ?? '',
      names: Object.fromEntries(d.scores.map((r) => [r.id, r.name])),
      viewed: d.viewed,
      rows: d.playerRows,
    }
  })
  const clampTo = (p, s) => ({
    x: Math.min(Math.max(p.x, s.view.w / 2), s.mapW - s.view.w / 2),
    y: Math.min(Math.max(p.y, s.view.h / 2), s.mapH - s.view.h / 2),
  })
  /** The camera is on `id`: the viewpoint is its drawn place, and the rig's centre its clamped place. */
  const onPlayer = (s, id, label) => {
    const body = s.drawn.find((p) => p.id === id)
    if (!body) {
      fail(`${label}: player ${id} is not drawn`)
      return null
    }
    const dv = Math.hypot(s.viewAt.x - body.x, s.viewAt.y - body.y)
    const want = clampTo(body, s)
    const dc = Math.hypot(s.centre.x - want.x, s.centre.y - want.y)
    console.log(`  ${label}: watching ${s.watching} drawn at (${body.x.toFixed(0)}, ${body.y.toFixed(0)}); viewpoint ${dv.toFixed(1)} px off (max ${VIEW_TOL}); camera centre (${s.centre.x.toFixed(0)}, ${s.centre.y.toFixed(0)}), ${dc.toFixed(1)} px from its clamped place (max ${CAMERA_TOL})`)
    // `!(… <= …)`: a NaN (a field that is not there) is a failure, not a pass.
    if (!(dv <= VIEW_TOL)) fail(`${label}: the viewpoint is ${dv.toFixed(1)} px from where player ${id} is drawn`)
    if (!(dc <= CAMERA_TOL)) fail(`${label}: the camera centre is ${dc.toFixed(1)} px from player ${id}`)
    return dv <= VIEW_TOL && dc <= CAMERA_TOL ? want : null
  }
  await sleep(SETTLE_MS)
  const a = await read()
  const A = a.watching
  const alive = await w.evaluate(() => [...window.__game.debug().playerIds])
  if (!alive.includes(A)) fail(`watching ${A}, who is not a player`)
  const atA = onPlayer(a, A, 'A')
  if (atA) ok(`the camera is on player ${A}`)
  if (!a.line?.includes('SPECTATING')) fail(`no spectate line: ${JSON.stringify(a.line)}`)

  // ------------------------------------------------------------------ 3. Tab → B (far enough from A to mean it); Shift+Tab → A
  let b = null
  let presses = 0
  for (let i = 0; i < 6; i++) {
    await w.keyboard.press('Tab')
    presses++
    await sleep(SETTLE_MS)
    const s = await read()
    if (s.watching === A) continue
    const bodyB = s.drawn.find((p) => p.id === s.watching)
    const bodyA = s.drawn.find((p) => p.id === A)
    if (!bodyB || !bodyA) continue
    const apart = Math.hypot(clampTo(bodyB, s).x - clampTo(bodyA, s).x, clampTo(bodyB, s).y - clampTo(bodyA, s).y)
    console.log(`  Tab ${presses}: watching ${s.watching}, its camera target ${apart.toFixed(0)} px from A's`)
    if (apart >= APART) {
      b = { s, apart, bodyA }
      break
    }
  }
  if (!b) {
    fail(`no Tab reached a player whose camera target is ${APART} px from A's in ${presses} presses — the leg proves nothing`)
  } else {
    const B = b.s.watching
    if (b.s.steps !== presses) fail(`the scene counted ${b.s.steps} Tab presses, the check pressed ${presses}`)
    if (B === A) fail('Tab did not change whom the camera watches')
    const atB = onPlayer(b.s, B, 'B')
    const fromA = Math.hypot(b.s.centre.x - clampTo(b.bodyA, b.s).x, b.s.centre.y - clampTo(b.bodyA, b.s).y)
    if (atB && fromA > CAMERA_TOL) ok(`Tab moved the camera to player ${B}, ${fromA.toFixed(0)} px from A's place`)
    else fail(`after Tab the camera is still ${fromA.toFixed(0)} px from A`)
    const name = b.s.line ?? ''
    const nameB = b.s.names[B]
    if (!nameB || !name.includes(nameB)) fail(`the spectate line does not name the watched player ${B} (${JSON.stringify(nameB)}): ${JSON.stringify(name)}`)
    else ok(`spectate line names B: ${JSON.stringify(name)}`)
    // T23.27C F5b: the HUD's numbers are B's — its health and jet fuel are B's row, and (where A's differ) not A's.
    // Fuel is in it because health alone is the cap for everyone here (`DEV_START_HEALTH`); the bots jet, ana stands.
    const rB = b.s.rows[B]
    const rA = b.s.rows[A]
    const v = b.s.viewed
    const same = (x, y) => x.health === y.health && x.fuel === y.fuel
    if (!rB || !same(v, rB)) fail(`the HUD shows ${JSON.stringify(v)}, watched player ${B}'s row is ${JSON.stringify(rB)}`)
    else if (!rA || same(rA, rB)) console.log(`  note: A and B both at ${JSON.stringify(rB)} — the HUD leg cannot tell them apart this run`)
    else ok(`the HUD shows B's numbers ${JSON.stringify(rB)}, not A's ${JSON.stringify(rA)}`)
    // The scoreboard did not open on Tab in spectate (it is the held key's there).
    if (/\d+ \S+:-?\d+/.test(b.s.hud)) fail(`Tab opened the scoreboard in spectate: ${JSON.stringify(b.s.hud)}`)
    await watcher.shot('spectate-b')
    // Shift+Tab steps back through the same order to A (each press one step).
    for (let i = 0; i < presses; i++) await w.keyboard.press('Shift+Tab')
    await sleep(SETTLE_MS)
    const back = await read()
    if (back.watching !== A) fail(`${presses} Shift+Tab did not return to A (${A}): watching ${back.watching}`)
    else if (onPlayer(back, A, 'back')) ok(`Shift+Tab ×${presses} returned to player ${A}`)
    const nameA = back.names[A]
    if (!nameA || !(back.line ?? '').includes(nameA)) fail(`after Shift+Tab the line does not name A (${JSON.stringify(nameA)}): ${JSON.stringify(back.line)}`)
  }

  // ------------------------------------------------------------------ 5. the control: Tab in a match is the scoreboard
  // `docs/78` §A1: "Tab keeps the scoreboard in a normal match". ana's Tab opens it (numeric rows on `#game-hud`) and
  // steps no camera; a second Tab closes it. (`full-round` held this leg, and is opt-in.)
  const hudOf = () => ana.page.evaluate(() => ({ hud: document.getElementById('game-hud')?.textContent ?? '', steps: window.__game.debug().watchSteps, spectating: window.__game.debug().spectating }))
  const closed = await hudOf()
  await ana.page.keyboard.press('Tab')
  await sleep(300)
  const open = await hudOf()
  await ana.page.keyboard.press('Tab')
  await sleep(300)
  const shut = await hudOf()
  const board = (t) => /\d+ \S+:-?\d+/.test(t)
  console.log(`  control (ana): scoreboard before ${board(closed.hud)}, after Tab ${board(open.hud)}, after a second Tab ${board(shut.hud)}; watch steps ${open.steps}`)
  if (open.spectating !== false) fail('the control client is in spectate mode')
  if (board(closed.hud) || !board(open.hud) || board(shut.hud)) fail(`the control: Tab did not toggle ana's scoreboard: ${JSON.stringify([closed.hud, open.hud, shut.hud])}`)
  else if (open.steps !== 0) fail(`the control: ana's Tab stepped a camera (${open.steps})`)
  else ok("control: in a match Tab toggles the scoreboard and steps nothing")

  // ------------------------------------------------------------------ 6. alive is the watched player's (F9)
  for (let i = 0; i < 6 && (await read()).watching !== anaMe; i++) {
    await w.keyboard.press('Tab')
    await sleep(300)
  }
  if ((await read()).watching !== anaMe) fail(`Tab never reached ana (${anaMe}) — leg 6 cannot run`)
  else {
    const before = await w.evaluate(() => window.__game.debug().death.meAlive)
    const mapH = await ana.page.evaluate(() => window.__game.debug().mapH)
    await ana.page.evaluate((h) => window.__game.debugPlace(300, h + 400), mapH)
    const died = await w
      .waitForFunction((id) => {
        const d = window.__game.debug()
        return d.watching === id && d.death.meAlive === false
      }, anaMe, { timeout: 5000, polling: 'raf' })
      .then(() => true)
      .catch(() => false)
    if (before !== true) fail(`the control: watching ana alive, the watcher's meAlive read ${before}`)
    else if (!died) fail("ana died on camera and the watcher's meAlive never went false — it is not the watched player's")
    else ok("alive follows the watched player: true while ana lived, false on her death")
  }
} catch (e) {
  fail(`spectate: ${e?.stack ?? e}`)
}
await finish(teardown)
