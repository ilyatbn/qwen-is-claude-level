#!/usr/bin/env node
/**
 * `round-restart` — T23.28: **a restart is clean.** Owner, from `make watch`: *"when games restart all the tombstones
 * and items leftover are still on the map and you cannot interact with them … when you restart the game there are
 * several seconds when there's a map with no textures visible but the player can already see it and move."*
 *
 * Measured before the fix (`tasks/M23/T23.28-*.md`): the server sent no `map_init` on a restart at all, so the client
 * kept round one's map, graves and pickups until a mask checksum disagreed ~5 s later, then showed the new map as
 * Phaser's flat rock while the lit terrain painted — with the round already running.
 *
 * One player (ana) and three frenzied bots, `DEV_PROBE=1` so the server's own round can be read (`probeRound`):
 *
 * 1. **Round one, the control.** Graves and pickups exist; the client's set equals the server's (ids, both ends), the
 *    layers draw what the mirror holds, and a pickup works (ana is placed on one; it leaves both ends).
 * 2. **The restart, during the gap.** ana votes; the client hears `new_round` (`cover.resets`). While the cover is up:
 *    the frame presented is the cover (pixels: five patches, the cover's flat colour), the server says the round has
 *    not started (`phase` lobby, the round clock still) and ana's body does not move although Space and D are held —
 *    both ends, two probes a second apart. Frames are stretched (`slowFrames`) so the gap is wide enough to measure.
 * 3. **No frame without the cover is unpainted.** A recorder on `requestAnimationFrame` logs every frame after the
 *    restart: each one without the cover has the map painted and its round announced; the control is that frames of
 *    both kinds were recorded.
 * 4. **After it: round two's set is the server's** (ids and drawn counts, both ends) — round one had some, so a
 *    client that kept them fails here; the picture is not the cover (the control for leg 2's pixels); Space and D move ana once
 *    the round plays (the control for leg 2's stillness); and a pickup in round two works.
 *
 *   node scripts/checks/round-restart.mjs
 */
import { startStack, enterBattle, freePort, tally, sleep } from './harness.mjs'
import { samplePatch, colourDelta } from './pixels.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'

const { fail, ok, finish } = tally('round-restart')
const K = rustConstants()
const PLAYER_H = K.get('PLAYER_H')
const ENDED_SECONDS = K.get('ENDED_SECONDS')
/** Long enough for round one to grow graves and pickups; the round is this check's, not the game's. */
const ROUND_S = 45
/** `ui/loadCover.ts`'s background, `#070b18`. */
const COVER = { r: 0x07, g: 0x0b, b: 0x18 }
/** A patch "is the cover" within this colour distance (PNG and scaling round a flat colour by a step or two). */
const COVER_TOL = 6
/** Frames held this long while the restart loads, so the gap holds two probes a second apart (swiftshader paints in ~3 s). */
const SLOW_MS = 120
/** A body that moved: more than rounding (world px). */
const MOVED_PX = 2

const stack = await startStack({
  port: await freePort(),
  label: 'round-restart',
  env: {
    BOT_COUNT: '3',
    FIXED_SEED: '4242',
    WEATHER: 'off',
    DEV_WARMUP_SECONDS: '2',
    ROUND_SECONDS: String(ROUND_S),
    DEV_BOT_FRENZY: '1',
    // Quick first deaths, so round one has graves (and their drops) early. Applied at first spawn only.
    DEV_START_HEALTH: '25',
    DEV_PROBE: '1',
  },
})
let ana = null
const teardown = async () => {
  if (ana?.pageErrors?.length) fail(`page errors: ${ana.pageErrors.join(' | ')}`)
  await stack.close()
}
const until = async (what, fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(150)
  }
}

try {
  ana = await stack.openClient({ name: 'ana' })
  const p = ana.page
  await enterBattle(p, { waitPlaying: true, expectPlayers: 4, label: 'round-restart' })
  const dbg = () => p.evaluate(() => window.__game.debug())
  const server = () => p.evaluate(() => window.__game.probeRound())
  const me = await p.evaluate(() => window.__game.debug().me)
  const bodyOf = (s) => s?.players?.find((q) => q.id === me) ?? null

  /**
   * Client and server sets, read back to back until they agree or the attempts run out (an event in flight).
   *
   * **Graves exactly; pickups one way — every pickup the client holds and draws is one the server holds.** Not the
   * reverse, and that is measured, not assumed: a *partial* pickup (`items/world.rs::resolve_pickups`, `Partial`)
   * emits `item_pickup` while the remainder stays on the ground, so the server keeps an item every client has
   * deleted (seen here: a bot took part of a 120-round stack, `item_pickup` went out, the item stayed). That is a
   * `game-core` bug filed with T23.28, not this task's; the leftover this check is about is the other direction — a
   * pickup drawn that the server does not have — and that one is asserted exactly. Server-only ids are printed.
   * `exact` asserts both directions, for an instant no pickup can have happened in: a round's start, where it is what
   * catches the new world's own pickups going unannounced (`room.rs::send_the_ground`).
   */
  const bothEnds = async (label, exact = false) => {
    let last = null
    for (let i = 0; i < 20; i++) {
      const s = await server()
      const d = await dbg()
      const serverItems = new Set(s?.items ?? [])
      const mirror = d.mirrorItems.map((x) => x.id)
      const ids = (xs) => [...xs].sort((a, b) => a - b).join(',')
      last = {
        items: { server: ids(serverItems), mirror: ids(mirror), held: d.worldItems, drawn: d.itemsDrawn },
        graves: { server: ids(s?.tombstones ?? []), held: d.tombstones, drawn: d.tombstonesDrawn },
      }
      const agree =
        s &&
        mirror.every((id) => serverItems.has(id)) &&
        (!exact || mirror.length === serverItems.size) &&
        d.worldItems === d.itemsDrawn &&
        s.tombstones.length === d.tombstones &&
        d.tombstones === d.tombstonesDrawn
      if (agree) {
        const only = [...serverItems].filter((id) => !mirror.includes(id))
        if (only.length) console.log(`  note: ${label}: server-only pickups ${only.join(',')} (the partial-pickup bug above)`)
        return { s, d, n: { items: mirror.length, graves: s.tombstones.length } }
      }
      await sleep(100)
    }
    fail(`${label}: the client's set is not the server's — ${JSON.stringify(last)}`)
    return null
  }

  /** Stand ana on a pickup the server holds and watch it leave both ends. */
  const pickUp = async (label) => {
    await until(`${label}: ana alive`, async () => (await dbg()).death?.meAlive, 20_000)
    const target = await until(
      `${label}: a pickup on the ground`,
      async () => {
        const s = await server()
        const d = await dbg()
        return d.mirrorItems.find((i) => i.source !== 'Crate' && i.grounded && s?.items?.includes(i.id)) ?? null
      },
      ROUND_S * 1000,
    )
    await p.evaluate(([x, y]) => window.__game.debugPlace(x, y), [target.x, target.y - PLAYER_H / 2])
    try {
      await until(
        `${label}: item ${target.id} picked up`,
        async () => {
          const s = await server()
          const d = await dbg()
          return !s.items.includes(target.id) && !d.mirrorItems.some((i) => i.id === target.id)
        },
        5000,
      )
      ok(`${label}: ana picked up item ${target.id} — gone from the server's set and the client's`)
    } catch (e) {
      fail(`${label}: ${String(e)} — standing on it at (${target.x}, ${target.y})`)
    }
  }

  // ------------------------------------------------------------------ 1. round one, the control
  await until('round one to grow a grave and a pickup', async () => {
    const s = await server()
    return (s?.tombstones?.length ?? 0) > 0 && (s?.items?.length ?? 0) > 0
  }, ROUND_S * 1000)
  const one = await bothEnds('round one')
  if (one) ok(`round one: ${one.n.items} pickups and ${one.n.graves} graves, the same set at both ends and drawn`)
  await pickUp('round one')

  // ------------------------------------------------------------------ 2. the restart, during the gap
  await until('round one to end', async () => (await dbg()).phase === 'ended', (ROUND_S + 10) * 1000)
  const leftover = await bothEnds('round one, ended')
  if (!leftover || leftover.n.items + leftover.n.graves === 0) fail('round one ended with nothing on the ground — leg 4 cannot see a leftover')
  else ok(`round one ended with ${leftover.n.items} pickups and ${leftover.n.graves} graves on the ground`)
  await p.evaluate(() => {
    const log = []
    window.__restartFrames = log
    const step = () => {
      try {
        const d = window.__game.debug()
        if (d.cover.resets > 0) log.push({ cover: d.cover.inDom, painted: d.cover.painted, phase: d.phase, ready: d.ready })
      } catch {
        /* a frame between scenes */
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  await p.evaluate((ms) => window.__game.slowFrames(ms), SLOW_MS)
  await p.click('.results-again', { timeout: 10_000 })
  await until('the restart (new_round)', async () => (await dbg()).cover.resets > 0, (ENDED_SECONDS + 10) * 1000)

  const s1 = await server()
  const c1 = (await dbg()).cover
  const patches = [
    // The middle of the screen, above the cover's caption (which sits at the centre).
    { x: 620, y: 200, w: 40, h: 40 },
    { x: 40, y: 40, w: 40, h: 40 },
    { x: 1200, y: 40, w: 40, h: 40 },
    { x: 40, y: 640, w: 40, h: 40 },
    { x: 1200, y: 640, w: 40, h: 40 },
  ]
  const covered = []
  for (const r of patches) covered.push(colourDelta(await samplePatch(p, r), COVER))
  await ana.shot('round-restart-gap')
  await p.keyboard.down('Space')
  await p.keyboard.down('KeyD')
  await sleep(1000)
  const s2 = await server()
  const c2 = (await dbg()).cover
  await p.keyboard.up('Space')
  await p.keyboard.up('KeyD')
  if (!c1.inDom || !c2.inDom) {
    fail(`the cover was not up across the gap's two probes (${c1.inDom}, ${c2.inDom}) — no cover, or a load faster than the probes (then raise SLOW_MS); the leg measured nothing`)
  } else {
    if (covered.every((dd) => dd < COVER_TOL)) ok(`the frame presented in the gap is the cover (patch distances ${covered.map((x) => x.toFixed(1)).join(', ')})`)
    else fail(`the frame presented in the gap is not the cover: patch distances ${covered.map((x) => x.toFixed(1)).join(', ')}`)
    const [b1, b2] = [bodyOf(s1), bodyOf(s2)]
    if (s1?.phase !== 'lobby' || s2?.phase !== 'lobby') fail(`the server started round two before ana had the map: phases ${s1?.phase}, ${s2?.phase}`)
    else ok('the server holds round two in its load (phase lobby at both probes) while ana loads')
    if (s1?.round_time !== s2?.round_time) fail(`the round clock ran during the load: ${s1?.round_time} -> ${s2?.round_time}`)
    if (!b1 || !b2 || Math.hypot(b2.x - b1.x, b2.y - b1.y) > MOVED_PX) fail(`ana moved during the load: ${JSON.stringify(b1)} -> ${JSON.stringify(b2)}`)
    else ok(`ana did not move during the load with Space and D held: (${b1.x.toFixed(1)}, ${b1.y.toFixed(1)}) both probes`)
  }
  await p.evaluate(() => window.__game.slowFrames(0))
  await until('the cover to lift', async () => !(await dbg()).cover.inDom, 60_000)

  // ------------------------------------------------------------------ 3. every uncovered frame is painted
  const frames = await p.evaluate(() => window.__restartFrames)
  const bare = frames.filter((f) => !f.cover)
  const bad = bare.filter((f) => !f.painted || !f.ready || (f.phase !== 'warmup' && f.phase !== 'playing'))
  if (frames.length - bare.length === 0 || bare.length === 0) fail(`the recorder saw ${frames.length - bare.length} covered and ${bare.length} uncovered frames — the control needs both`)
  else if (bad.length) fail(`${bad.length} of ${bare.length} uncovered frames were not ready to show: ${JSON.stringify(bad.slice(0, 3))}`)
  else ok(`${frames.length - bare.length} frames covered, then ${bare.length} uncovered — every one painted, its round started`)

  // ------------------------------------------------------------------ 4. after it
  const two = await bothEnds('round two', true)
  if (two) ok(`round two starts with the server's own set: ${two.n.items} pickups, ${two.n.graves} graves, at both ends and drawn`)
  const open = colourDelta(await samplePatch(p, patches[0]), COVER)
  if (open < COVER_TOL * 3) fail(`after the cover lifted the screen still reads as the cover (distance ${open.toFixed(1)}) — the gap's pixel leg proves nothing`)
  else ok(`the control: the world is on screen once it lifts (distance ${open.toFixed(1)} from the cover)`)
  await ana.shot('round-restart-after')
  await until('round two to play', async () => (await dbg()).phase === 'playing', 30_000)
  await until('ana alive in round two', async () => (await dbg()).death?.meAlive, 20_000)
  const m1 = bodyOf(await server())
  await p.keyboard.down('Space')
  await p.keyboard.down('KeyD')
  await sleep(1000)
  await p.keyboard.up('Space')
  await p.keyboard.up('KeyD')
  const m2 = bodyOf(await server())
  if (!m1 || !m2 || Math.hypot(m2.x - m1.x, m2.y - m1.y) <= MOVED_PX) fail(`the control: Space and D held for a second in Playing did not move ana either (${JSON.stringify(m1)} -> ${JSON.stringify(m2)}) — the stillness above is not evidence`)
  else ok(`the control: Space and D move ana once round two plays (${Math.hypot(m2.x - m1.x, m2.y - m1.y).toFixed(0)} px)`)
  await pickUp('round two')
} catch (e) {
  fail(String(e?.stack ?? e))
}
await finish(teardown)
