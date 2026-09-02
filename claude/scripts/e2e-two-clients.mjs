#!/usr/bin/env node
/**
 * The M6 checkpoint: two browsers, one round, terrain destruction visible in
 * both, scores tracking.
 *
 *   node scripts/e2e-two-clients.mjs
 *
 * This is the first point at which the project is a multiplayer game rather
 * than a collection of parts, so it asserts on the things that would make it
 * not one: both clients decode the same map, each sees the other move, a rocket
 * fired by one craters the map in *both*, and their mask checksums match.
 *
 * Screenshots from both contexts land in `shots/` and are meant to be looked at.
 *
 * The stack and the route into a battle are `harness.mjs` (§C18). Two humans
 * satisfy `MIN_PLAYERS_TO_START`, so this one *would* start on the lobby
 * countdown — but waiting on a countdown that another task may retune is a test
 * that expires (§A32), and `enterBattle` is where that decision lives now.
 */
import { join } from 'node:path'
import { startStack, enterBattle, sleep, shotsDir } from './checks/harness.mjs'

const PORT = 3112
const shots = shotsDir

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

const stack = await startStack({
  port: PORT,
  label: 'two-clients',
  env: {
    // No bots: this test counts players, and a bot is a player (§A5).
    // **Long enough for a second client to be seated** (§E2, T17.08's knob).
    // Seating on `welcome` rather than `ready` is necessary and not sufficient:
    // ana's lobby can still time out while bo's page is loading, and then §E4
    // refuses him and quick match gives him a room of his own. That failure is
    // intermittent rather than certain, which is worse. This makes the window
    // wider than two cold page loads.
    LOBBY_BOT_TIMEOUT: '120',
    BOT_COUNT: '0',
    // Arm the players: the checkpoint has to fire a rocket, and finding one
    // first is the game's design, not this test's job.
    DEV_LOADOUT: '1',
  },
})

async function openClient(name) {
  const c = await stack.openClient({ name })
  return { page: c.page, errors: c.pageErrors, name: c.name }
}

const dbg = (c) => c.page.evaluate('window.__game.debug()')


const a = await openClient('ana')
const b = await openClient('bo')

// Into a running round. Ana asks; bo is already in the room and simply follows
// it out of the lobby, which is also the assertion that a second client sees
// the same start (`press: false` is not a shortcut — it is the other half).
await enterBattle(a.page, { expectPlayers: 2, label: 'two-clients/ana' })
await enterBattle(b.page, { press: false, expectPlayers: 2, label: 'two-clients/bo' })

// Both joined and decoded the same map.
const da0 = await dbg(a)
const db0 = await dbg(b)
if (da0.mapW !== db0.mapW || da0.mapH !== db0.mapH) {
  fail(`map size differs: ${da0.mapW}x${da0.mapH} vs ${db0.mapW}x${db0.mapH}`)
}
// **`roundSeed`, not `seed`.** `debug().seed` is `core.meta.seed` — this
// client's *local* core, which in a networked round never generates the map; it
// is handed the mask by `map_init`. Both clients therefore reported the same
// constant and this assertion was `x !== x`: it could not fail, while sitting
// directly above `maskChecksum` and reading like a second independent check.
// `roundSeed` is what `welcome` carried, which is the seed the server generated
// from — so this now compares something the two clients could actually disagree
// about.
if (!da0.roundSeed || !db0.roundSeed) {
  fail(
    `a client reported no roundSeed (${da0.roundSeed} / ${db0.roundSeed}) — the ` +
      'comparison below cannot fail, so it proves nothing',
  )
}
if (String(da0.roundSeed) !== String(db0.roundSeed)) {
  fail(`round seed differs: ${da0.roundSeed} vs ${db0.roundSeed}`)
}
if (da0.maskChecksum !== db0.maskChecksum) fail('masks differ immediately after join')

// Each sees two players. Poll rather than sleep: on a loaded box the second
// client's first snapshot can land well after any constant someone picks.
const until = async (c, ok, what, deadlineMs = 20_000) => {
  const started = Date.now()
  let last
  while (Date.now() - started < deadlineMs) {
    last = await dbg(c)
    if (ok(last)) return last
    await sleep(200)
  }
  fail(`${what} (gave up after ${deadlineMs} ms)`)
  return last
}
/**
 * Poll an arbitrary probe until it satisfies `ok`, then return its value.
 *
 * The debug-state `until` above only works for `__game.debug()`. This is the
 * same idea for anything else — DOM text, a HUD handle — and it exists because
 * a fixed `setTimeout` after a keypress measures the box, not the game. Under a
 * deliberate 14-core load the movement check (which polls) survived at 17.7 px
 * while the slot-select check (which slept 250 ms) failed outright. Waiting on
 * the effect makes load irrelevant instead of moving a threshold (§A28).
 */
const untilValue = async (probe, ok, what, deadlineMs = 15_000) => {
  const started = Date.now()
  let last
  while (Date.now() - started < deadlineMs) {
    last = await probe()
    if (ok(last)) return last
    await sleep(100)
  }
  fail(`${what} (gave up after ${deadlineMs} ms)`)
  return last
}

const da1 = await until(a, (d) => d.playerCount >= 2, 'ana never saw two players')
const db1 = await until(b, (d) => d.playerCount >= 2, 'bo never saw two players')
if (da1.playerCount < 2) fail(`ana sees ${da1.playerCount} players, expected 2`)
if (db1.playerCount < 2) fail(`bo sees ${db1.playerCount} players, expected 2`)

// The remote one moves when the other holds a key. Hold until bo has actually
// moved rather than for a fixed 1200 ms: the client steps a fixed timestep off
// requestAnimationFrame, so under load it simulates fewer ticks per wall-clock
// second and a constant sleep measures the box rather than the game. This is
// the failure recorded three times as "two-clients fails in the suite, passes
// standalone" — most recently as `bo held D and moved only 0.0 px locally`.
const bx0 = db1.player?.x ?? 0

/**
 * Hold a direction until bo has actually moved.
 *
 * Two things this is careful about. **Not a fixed sleep**: the client steps a
 * fixed timestep off requestAnimationFrame, so under load it simulates fewer
 * ticks per wall-clock second and a constant window measures the box rather than
 * the game — the failure recorded three times as "two-clients fails in the
 * suite, passes standalone". The fixed 1200 ms is kept because it is what has
 * always worked, and the poll only extends it.
 *
 * And **either direction**. What is being asserted is that a remote body moves
 * when its owner holds a key; which way is not the point, and a spawn with a
 * wall to its right is a legal spawn — `bo held D and moved only 0.0 px` is a
 * true report about terrain.
 */
const holdUntilMoved = async (key) => {
  await b.page.keyboard.down(key)
  await sleep(1200)
  let moved = 0
  for (let i = 0; i < 40; i++) {
    const d = await dbg(b)
    moved = Math.abs((d.player?.x ?? 0) - bx0)
    if (moved > 8) break
    await sleep(250)
  }
  await b.page.keyboard.up(key)
  await sleep(400)
  return moved
}

let heldKey = 'd'
if ((await holdUntilMoved('d')) <= 8) {
  heldKey = 'a'
  await holdUntilMoved('a')
}
const aAfter = await dbg(a)
const bAfter = await dbg(b)
const bMoved = Math.abs(bAfter.player.x - db1.player.x)
if (bMoved < 5) {
  fail(
    `bo held ${heldKey.toUpperCase()} — and then the other way — and moved only ` +
      `${bMoved.toFixed(1)} px locally`,
  )
}
// Control: ana must actually have a remote body to have been watching, or
// "the remote moved" is satisfied by a client rendering nobody.
if ((aAfter.players?.length ?? 0) < 1) fail('ana had no remote player to watch')

/**
 * Wait until every client's mask stops changing *and* nothing is left buffered,
 * or give up after `deadlineMs`.
 *
 * The fixed `setTimeout` this replaces is a latent flake by construction: it
 * reads an accumulating buffer at a wall-clock instant, so it passes on an idle
 * box and reports mask divergence on a loaded one — which is how this check came
 * to be recorded three times as "fails inside a loaded suite run, passes
 * standalone". Waiting on the effect makes the load irrelevant instead of making
 * the sleep longer, which only moves the threshold (§A28).
 */
async function settle(clients, deadlineMs = 20_000) {
  const started = Date.now()
  let last = null
  let stableFor = 0
  while (Date.now() - started < deadlineMs) {
    const now = await Promise.all(clients.map((c) => dbg(c)))
    const key = now.map((d) => `${d.solid}:${d.maskChecksum}:${d.pendingCarves}`).join('|')
    const quiet = now.every((d) => d.pendingCarves === 0)
    if (quiet && key === last) {
      stableFor += 1
      if (stableFor >= 3) return now
    } else {
      stableFor = 0
    }
    last = key
    await sleep(250)
  }
  return await Promise.all(clients.map((c) => dbg(c)))
}

// A rocket fired by one craters the map in both.
//
// **Aimed, and paced by the weapon's own cadence.** This fired twelve times at
// whatever angle the mouse happened to sit at — Playwright leaves it at the
// top-left corner, so the shots went up and to the left, and whether they hit
// any terrain at all was luck of the spawn point. Measured across four runs the
// same twelve calls destroyed 4071, 6969, 9164 and 9291 px, and a run that
// destroys nothing is inside that distribution rather than outside it: the
// failure this repairs was a **latent flake of its own**, not a consequence of
// §F1 (the SMG is never reached — see below).
//
// Two things make it deliberate. It aims **down and to the side**, so the rocket
// meets ground a short distance away whatever the terrain looks like, and it
// spaces the shots by `BAZOOKA_COOLDOWN` so every one is accepted. At 250 ms
// against a 900 ms cooldown, **nine of the twelve calls were silently refused**
// and the check measured three rockets while believing it had fired twelve.
const k = await a.page.evaluate('window.__game.constants()')
// Down-and-right at ~45°. Not straight down: the blast radius is 42 px and the
// zoom is 2, so a 200 px screen offset is 100 world px of separation — outside
// the blast, and three point-blank rocket jumps would kill her before the
// inventory assertions below ever ran.
await a.page.mouse.move(640 + 200, 360 + 200)
await sleep(200)
const solidBeforeA = (await dbg(a)).solid
const solidBeforeB = (await dbg(b)).solid
const spawnsBefore = (await dbg(a)).observed?.projectileSpawns ?? 0
// The whole stack, at the cadence that empties it.
const rockets = Math.round(k.BAZOOKA_AMMO)
for (let i = 0; i < rockets; i++) {
  await a.page.evaluate('window.__game.fire()')
  await sleep(k.BAZOOKA_COOLDOWN * 1000 + 120)
}
const [daF, dbF] = await settle([a, b])
const removedA = solidBeforeA - daF.solid
const removedB = solidBeforeB - dbF.solid

// **Count the shots at both ends.** The old loop could have every call refused
// and still pass on a single lucky rocket, which is how it came to believe it
// fired twelve. If the server did not accept what we sent, that is the finding —
// not the smaller crater it produces.
const spawnsAfter = (await dbg(a)).observed?.projectileSpawns ?? 0
if (spawnsAfter - spawnsBefore !== rockets) {
  fail(`fired ${rockets} but only ${spawnsAfter - spawnsBefore} rockets left the muzzle`)
}

// The control: if nothing was destroyed, "both agree" is satisfied by two
// clients that both did nothing.
if (removedA <= 0) fail(`no terrain was destroyed (ana removed ${removedA} px)`)
if (removedA !== removedB) fail(`terrain differs: ana removed ${removedA}, bo removed ${removedB}`)
if (daF.maskChecksum !== dbF.maskChecksum) {
  fail(`mask checksums diverged after firing:\n  ana ${daF.maskChecksum}\n  bo  ${dbF.maskChecksum}`)
}
if (daF.pendingCarves !== 0 || dbF.pendingCarves !== 0) {
  fail(`carves left buffered: ana ${daF.pendingCarves}, bo ${dbF.pendingCarves}`)
}

// ---------------------------------------- the late joiner, abolished by §E4
//
// This asserted that a third client joining a round in progress received the
// already-damaged map and agreed with it. **§E4 closed every path that could
// produce that**: a join against a room past `Lobby` is refused with
// `in_progress`, and quick match skips such rooms, so `cy` was landing in a room
// of her own with a pristine map — the checksum mismatch was two different
// worlds, not a catch-up bug.
//
// **Deleted rather than re-pointed**, for the same reason as
// `a_mid_round_joiner_sees_the_graves_that_are_already_there` in T17.05: there is
// no production route to a running match left, and a check that manufactures one
// asserts nothing about production. The catch-up code it exercised is still
// there and is already declared dormant at its site in `session.rs`, kept for the
// reconnection seam §E4 leaves open on purpose.
//
// **When reconnection lands, this is the check to write again** — same shape,
// against a client rejoining a match it was already seated in.

// T8.05 — the inventory verbs. `Connection` has had sendSelectSlot and
// sendUseItem since T6.08 and nothing in the scene called them, so a medkit, a
// shield and the flashlight were all unusable in the real game while every unit
// test passed. Asserting that something *changes* is the point: a keybinding
// that is registered but wired to nothing looks identical from outside.
//
// Read from the **panel and the selection index**, not from the HUD text. §C10
// gave the inventory a quick bar and a backpack and took the 24-slot line out of
// the text strip, so "the strip gained a newline" now measures a strip that no
// longer carries the inventory at all.
{
  const state = async () => {
    const d = await a.page.evaluate('window.__game.debug()')
    return { selected: d.selectedSlot, open: d.overlays?.inventory ?? false, slots: d.slots }
  }
  const before = await state()
  // **Pick a slot that is not the one already selected, and say which.**
  //
  // This pressed `Digit2` and asserted only that the selection *changed*. Two
  // things were wrong with that and the second one hid the first: the quick bar
  // is one-indexed, so `Digit2` selects **slot 1**, not slot 2 — and it passed
  // only because the selection happened to start at 0. Now that the bazooka
  // stack is emptied above, `consume` re-selects to the SMG at slot 1, `Digit2`
  // asks for the slot already held, and the assertion fails against a client
  // that is behaving perfectly.
  //
  // So: choose the first quick-bar slot that holds something and is not current,
  // press its key, and assert the selection lands **on that slot**. Asserting
  // where it went rules out a handler that moves the selection somewhere.
  const target = (before.slots ?? []).find(
    (sl) => sl && sl.key && sl.slot !== before.selected && sl.slot < 8,
  )
  if (!target) fail(`no quick-bar slot to switch to (selected ${before.selected})`)
  await a.page.keyboard.press(`Digit${target.slot + 1}`)
  const afterSelect = await untilValue(
    state,
    (t) => t.selected === target.slot,
    `Digit${target.slot + 1} did not select slot ${target.slot} (still ${before.selected})`,
  )
  if (afterSelect.selected !== target.slot) {
    fail(`Digit${target.slot + 1} did not select slot ${target.slot} (still ${afterSelect.selected})`)
  }

  if (before.open) fail('the backpack was already open before any right-click')
  await a.page.mouse.click(640, 360, { button: 'right' })
  const withPanel = await untilValue(state, (t) => t.open, 'right-click did not open the backpack')
  if (!withPanel.open) fail('right-click did not open the backpack')
  // ...and the panel is really on the screen, not merely flagged open.
  const laidOut = await a.page.evaluate(() => {
    const el = document.getElementById('inventory-backpack')
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1
  })
  if (!laidOut) fail('the backpack reports itself open but has no rect on the screen')

  await a.page.mouse.click(640, 360, { button: 'right' })
  const closed = await untilValue(state, (t) => !t.open, 'a second right-click did not close it')
  if (closed.open) fail('a second right-click did not close the backpack')
  console.log('  inventory: slot select and the backpack panel both respond')
}

// T8.03 — the F3 HUD, checked here because this is the only place a *server* is
// running: every number on it (rtt, snapshot rate, reconciliation, checksum) is
// meaningless without one, and a HUD asserted against a sandbox with no network
// would be asserting zeros.
const hudBefore = await a.page.evaluate('window.__game.debugHud()')
if (hudBefore.visible) fail('the debug HUD is visible before F3 is pressed')
// --- world items are drawn, not merely tracked (T9.03) --------------------
// Two numbers, because they were silently different for three milestones: the
// mirror tracked items from T6.08 and nothing rendered them, so a medkit on the
// ground was invisible. Asserting only "the server spawned items" would have
// passed the whole time.
const itemsA = await dbg(a)
if (itemsA.worldItems > 0 && itemsA.itemsDrawn === 0) {
  fail(`${itemsA.worldItems} world items exist and ${itemsA.itemsDrawn} are drawn`)
}
if (itemsA.itemsDrawn > itemsA.worldItems) {
  fail(`drew ${itemsA.itemsDrawn} items from ${itemsA.worldItems}`)
}
console.log(`  items: ${itemsA.itemsDrawn} drawn of ${itemsA.worldItems} tracked`)

await a.page.keyboard.press('F3')
const hud = await untilValue(
  () => a.page.evaluate('window.__game.debugHud()'),
  (h) => h.visible,
  'F3 did not show the debug HUD',
)
if (!hud.visible) fail('F3 did not show the debug HUD')
{
  const text = hud.text
  // The two numbers docs/42 §8 exists for. Their absence is the failure mode:
  // a HUD that shows rtt and nothing else does not turn a netcode bug into a
  // reading.
  for (const needle of ['reconcile', 'mean', 'max', 'snapshots', 'inputs', 'pending', 'mask']) {
    if (!text.includes(needle)) fail(`the debug HUD does not report "${needle}":\n${text}`)
  }
  // And they must be live, not placeholders: this client has been sending input
  // and receiving snapshots for several seconds.
  const snaps = Number(/snapshots ([\d.]+)\/s/.exec(text)?.[1] ?? '0')
  const inputs = Number(/inputs ([\d.]+)\/s/.exec(text)?.[1] ?? '0')
  if (!(snaps > 1)) fail(`the HUD reports ${snaps} snapshots/s against a 20 Hz server`)
  if (!(inputs > 1)) fail(`the HUD reports ${inputs} inputs/s while this client is sending them`)
  if (!/mask (matched|pending)/.test(text)) fail(`mask status missing:\n${text}`)
  // RTT was hardcoded to 0 and never measured; the HUD's headline number was a
  // constant. On loopback it is sub-millisecond, so assert it is *measured*
  // (present and finite) rather than asserting a threshold a LAN would fail.
  const rttSeen = /rtt ([\d.]+)ms/.test(text)
  if (!rttSeen) fail(`the HUD does not report rtt:\n${text}`)
  const pinged = await a.page.evaluate('window.__game.debug().rttMeasured')
  if (!pinged) fail('rtt is not being measured — no pong_rtt was ever received')
  console.log(`  debug HUD: ${snaps.toFixed(1)} snapshots/s, ${inputs.toFixed(1)} inputs/s`)
}
// Layer parity for the scene that was actually broken (§C1).
//
// `terrain-render` asserts the sandbox's world layers, which is the scene that
// always worked. GameScene needs a live server to build a world, so this is the
// only check that can see it — and this is where the divergence that caused §C0
// would show up first.
//
// Measured, not reasoned from the DEPTH table — my first version of this listed
// nine depths and the game builds twelve. Guessing a layer set and calling the
// difference a regression is how a fixture reports working code as broken.
//   -30,-29,-28 sky   0 terrain   9 teleport pads   10 decorations   11 tombstones
//   19 crate chutes/beacons   20 world items   30 actors   39 weather vignette
//   40 particles   45 ordnance fx   50 lightmap
// 38 is the sandbox's own hazard graphics and is deliberately absent here: it is
// scene furniture, not a world layer, which is why the two lists differ by it.
//
// 19 is the parachute and beacon graphics T13.05 adds, drawn *behind* the items
// at 20 so a falling crate hangs under its canopy. It appears in both scenes
// because `WorldView` owns the item layer; when it was built in `GameScene`
// alone this check caught the difference, which is exactly what it is for.
//
// 9 is T15.01's teleport pads (§C5), between the terrain and the decorations: you
// stand *on* a pad, so the actors must draw over it. It appears in both scenes
// for the same reason 19 does — and it caught this one too. The layer was built
// in `GameScene` first and this assertion reported it verbatim, which is the
// second time it has paid for itself.
{
  // -22, -21, -20 are T15.03's living background (§C14): two mountain ridge
  // layers with the cloud layer between them, all below `PARALLAX_FACTOR`.
  // -19 is T15.04's birds (§C16), which draw **behind the terrain** — that is
  // what "no collision with terrain" looks like on screen, and it is why they
  // sit between the parallax and 0 rather than with the actors.
  //
  // This list was stale before T15.04 touched it: T15.03 added its three depths
  // and updated `terrain-render`'s copy of this assertion but not this one, so
  // the two scenes' parity check had already gone red. Both are updated now.
  const GAME_LAYERS = [
    -30, -29, -28, -22, -21, -20, -19, 0, 9, 10, 11, 19, 20, 30, 39, 40, 45, 50,
  ]
  const depths = await a.page.evaluate('window.__game.sceneDepths()')
  if (!Array.isArray(depths) || depths.length === 0) {
    fail('GameScene.sceneDepths() returned nothing — this assertion could not fail')
  }
  if (depths.join(',') !== GAME_LAYERS.join(',')) {
    fail(
      `the game builds world layers [${depths.join(',')}], expected ` +
        `[${GAME_LAYERS.join(',')}] — a layer added to one scene and not the shared ` +
        'stack is §C0 starting again',
    )
  }
  console.log(`  layer parity: game builds [${depths.join(',')}]`)
}

await a.page.screenshot({ path: join(shots, 'm6-debug-hud.png') })
await a.page.keyboard.press('F3')

await a.page.screenshot({ path: join(shots, 'm6-client-a.png') })
await b.page.screenshot({ path: join(shots, 'm6-client-b.png') })

const allErrors = [...a.errors, ...b.errors]
if (allErrors.length) fail(`page errors: ${allErrors.slice(0, 3).join(' | ')}`)

console.log(
  JSON.stringify(
    {
      map: `${da0.mapW}x${da0.mapH}`,
      seed: String(da0.seed),
      playersSeen: { ana: da1.playerCount, bo: db1.playerCount },
      boMovedPx: Number(bMoved.toFixed(1)),
      terrainRemoved: { ana: removedA, bo: removedB },
      checksum: daF.maskChecksum.slice(0, 16),
      corrections: { ana: daF.corrections, bo: dbF.corrections },
      resyncs: { ana: daF.resyncs, bo: dbF.resyncs },
      pageErrors: allErrors.length,
    },
    null,
    1,
  ),
)

await stack.close()
if (process.exitCode) console.error('\ne2e-two-clients FAILED')
else console.log('\ne2e-two-clients: two clients, one round, one map')
// Explicit: vite and cargo leave handles open that would keep node alive well
// past the point the test has answered its question.
process.exit(process.exitCode ?? 0)
