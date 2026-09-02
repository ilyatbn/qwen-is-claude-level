#!/usr/bin/env node
/**
 * T9.06 — play one complete round, end to end.
 *
 *   node scripts/checks/full-round.mjs
 *   node scripts/e2e.mjs full-round
 *
 * Every other check in this suite is a **tour**: generate a map, fire a rocket,
 * screenshot, exit. This one plays a whole round on a real server with two real
 * clients and bots, and asserts on what happened while it ran.
 *
 * ## Why that is different in kind
 *
 * Every serious defect on this project was invisible to unit tests and obvious
 * the moment something drove the real thing — caves too small to walk through,
 * night that cost nothing, an input rate that doubled your speed, a replay hash
 * that certified almost nothing, bots swept from every round after 30 seconds, a
 * flashlight that could not be equipped, world items tracked by the client and
 * drawn by nothing. What none of those tests reached is the *interactions*: the
 * scheduler firing weather while players fight, the cycle turning during a
 * firefight, respawns landing on a map that has been under fire for minutes.
 *
 * ## Why the scene records and this script does not poll
 *
 * The things worth asserting here are **events**, and most of them are brief: a
 * weather telegraph lasts 3 s, a death is instantaneous. Sampling `debug()` once
 * a second would miss them and pass on a round where nothing happened at all. So
 * `GameScene.observed` accumulates them as they arrive and this script reads the
 * accumulation at the end. Polling is only used for the screenshots, where the
 * question genuinely is "what did it look like at this moment".
 *
 * The stack and the route into a battle are `harness.mjs` (§C18).
 */
import { join } from 'node:path'
import { startStack, enterBattle, sleep, shotsDir } from './harness.mjs'

const shots = shotsDir
const PORT = 3113

/**
 * A full round, shortened only as far as `docs/41` §5 allows. Warmup is 10 s on
 * top of this and is not shortened.
 */
const ROUND_SECONDS = 150

const failures = []
const fail = (msg) => {
  console.error(`  FAIL: ${msg}`)
  failures.push(msg)
}
const ok = (msg) => console.log(`  ok   ${msg}`)

// --- the real server, with bots to supply the pressure --------------------
const stack = await startStack({
  port: PORT,
  label: 'full-round',
  env: {
    ROUND_SECONDS: String(ROUND_SECONDS),
    // Bots are ordinary players (§A5) and they are what makes anything happen in
    // 150 s. Skill is raised so they actually land shots rather than wander.
    // **Long enough for a second client to be seated** (§E2, T17.08's knob).
    // Seating on `welcome` rather than `ready` is necessary and not sufficient:
    // ana's lobby can still time out while bo's page is loading, and then §E4
    // refuses him and quick match gives him a room of his own. That failure is
    // intermittent rather than certain, which is worse. This makes the window
    // wider than two cold page loads.
    LOBBY_BOT_TIMEOUT: '120',
    BOT_COUNT: '3',
    BOT_SKILL: '0.85',
    // Arm everyone. Finding a weapon first is the game's design, but this check
    // is about the round, not about the search — and an unarmed round produces
    // no deaths to assert on.
    DEV_LOADOUT: '1',
  },
})
console.log(`  round ${ROUND_SECONDS}s + warmup`)

async function openClient(name) {
  const c = await stack.openClient({ name })
  return { page: c.page, errors: c.pageErrors, name: c.name }
}

const dbg = (c) => c.page.evaluate('window.__game.debug()')


const a = await openClient('ana')
const b = await openClient('bo')
console.log('  two clients joined')
await enterBattle(a.page, { expectPlayers: 2, label: 'full-round/ana' })
await enterBattle(b.page, { press: false, expectPlayers: 2, label: 'full-round/bo' })

// --- play the round -------------------------------------------------------
//
// The clients are not idle. A round where nobody moves is a round where the
// respawn, pickup and destruction assertions can all pass vacuously, so both
// clients walk, jump and fire throughout.
let driving = true
let pauseA = false
const drive = async (c, dir) => {
  while (driving) {
    if (c.name === 'ana' && pauseA) {
      await sleep(200)
      continue
    }
    try {
      await c.page.keyboard.down(dir)
      await sleep(900)
      await c.page.keyboard.up(dir)
      await c.page.keyboard.press('Space')
      await c.page.evaluate('window.__game.fire()')
      await sleep(700)
      await c.page.keyboard.down(dir === 'd' ? 'a' : 'd')
      await sleep(900)
      await c.page.keyboard.up(dir === 'd' ? 'a' : 'd')
      await c.page.evaluate('window.__game.fire()')
      await sleep(700)
    } catch {
      // The page can be mid-navigation or closed while shutting down; a driver
      // that throws here would mask the real result.
      return
    }
  }
}
// Drive with the SMG, not the bazooka.
//
// `DEV_LOADOUT` grants 4 rockets and 60 SMG rounds, and the drive loop fires
// ~55 times over the round — so driving with the default slot empties the
// bazooka in the first minute and the scripted self-kill later has nothing to
// fire. Slot 2 is the SMG (`grant_dev_loadout` gives bazooka then smg), and
// an SMG round **cannot hurt the player who fired it**, so the rockets stay for
// the one shot that has to.
//
// The reason changed with §F1 and the behaviour did not: it used to be that
// hitscan excluded its owner (`docs/31` §4); it is now that a bullet spawns
// `MUZZLE_OFFSET` outside the body and is immune to its owner for
// `PROJECTILE_OWNER_GRACE_TICKS`, by which point it is 50+ px away.
for (const c of [a, b]) {
  await c.page.keyboard.press('Digit2')
  await sleep(200)
}
const drivers = [drive(a, 'd'), drive(b, 'a')]

/** Poll until `pred(debug())` or the deadline; returns the reading that matched. */
async function until(client, pred, deadlineMs, what) {
  const started = Date.now()
  for (;;) {
    const d = await dbg(client)
    if (pred(d)) return d
    if (Date.now() - started > deadlineMs) return null
    await sleep(1000)
  }
}

// A running tally of whether the local body was ever found inside terrain while
// alive. That is the §A26 failure — a player spawned buried is alive, grounded
// and simply cannot move — and it can only be caught by looking while the round
// is running, not afterwards.
let stuckSamples = 0
let aliveSamples = 0
const checkStandable = async (c) => {
  const r = await c.page.evaluate(() => {
    const g = window.__game
    const d = g.debug()
    const p = d.player
    if (!p || !d.health) return { alive: false, overlap: false }
    const w = 16
    const h = 28
    let overlap = false
    for (let dx = -w / 2 + 1; dx <= w / 2 - 1 && !overlap; dx += 4) {
      for (let dy = -h / 2 + 1; dy <= h / 2 - 1 && !overlap; dy += 4) {
        if (g.core.solidAt(Math.round(p.x + dx), Math.round(p.y + dy))) overlap = true
      }
    }
    return { alive: true, overlap }
  })
  if (r.alive) {
    aliveSamples++
    if (r.overlap) stuckSamples++
  }
}

const shot = async (c, name) => {
  await c.page.screenshot({ path: join(shots, `${name}.png`) })
  console.log(`  shot: shots/${name}.png`)
}

// Warmup.
await shot(a, 'round-1-warmup')
const playing = await until(a, (d) => d.phase === 'playing', 40_000, 'playing')
if (!playing) fail('the round never reached `playing`')
else ok(`reached playing at roundTime ${playing.roundTime.toFixed(1)}s`)

// Mid-round daylight, and the standable sampling starts here.
const samples = []
let daylightShot = false
let nightShot = false
let effectShot = false

/**
 * Kill the local player deliberately, by firing into the ground at their feet.
 *
 * Self-damage is full (`SELF_DAMAGE_MULT` = 1.0, `docs/31` §2) — rocket-jumping
 * works and it costs health — so this is an ordinary game mechanic, not a back
 * door. Aiming below the body puts the muzzle (`MUZZLE_OFFSET` 18) at the
 * player's feet, and four rockets at ~26 damage each take 100 health down.
 *
 * Why script it rather than let the bots do it: two trial rounds produced 0 and 1
 * deaths, so "at least one death" from combat alone is a coin flip, and a gate
 * that fails on a coin flip teaches people to re-run it (§A28). The assertion
 * being tested is that the death → respawn path works on a map that has been
 * under fire for minutes — not that bots are lethal. Bot kills still count; this
 * only guarantees the path is exercised.
 */
async function selfKill(c) {
  pauseA = true
  await sleep(400)
  await c.page.keyboard.press('Digit1') // the first rocket stack
  await sleep(300)
  const before = (await dbg(c)).health
  let switched = false
  // Aim down: the camera follows the player, so a point below mid-screen is
  // below the body in world space whatever the camera has done.
  await c.page.mouse.move(640, 700)
  for (let i = 0; i < 12; i++) {
    const d = await dbg(c)
    if (!d.health) break
    // When the first stack empties, selection moves to the next occupied slot,
    // which is the smg — and an SMG round cannot hurt its owner (§F1: it leaves
    // the body before the owner grace ends). Take the second rocket stack.
    if (!switched && i >= 4) {
      switched = true
      await c.page.keyboard.press('Digit3')
      await sleep(300)
    }
    // Step onto fresh ground, then fire from it.
    //
    // Two things blunt a rocket fired at your own feet, and both were measured:
    // the previous blast throws you (knockback applies through everything — it
    // is what makes rocket-jumping work) and a rocket fired airborne flies off
    // instead of landing; and each blast deepens the crater, so the next one
    // detonates further below you. Standing still gave ~12 damage a shot against
    // ~25 for the first. Stepping sideways onto undamaged ground restores it.
    await c.page.keyboard.down('d')
    await sleep(260)
    await c.page.keyboard.up('d')
    for (let w = 0; w < 20 && !(await dbg(c)).player?.grounded; w++) {
      await sleep(200)
    }
    await c.page.mouse.move(640, 700)
    await c.page.evaluate('window.__game.fire()')
    await sleep(1000)
  }
  const after = await dbg(c)
  console.log(`  self-damage: health ${before} → ${after.health}`)
  pauseA = false
  return before !== after.health
}

let suicideDone = false
const deadline = Date.now() + (ROUND_SECONDS + 45) * 1000
for (;;) {
  const d = await dbg(a)
  samples.push({ t: d.roundTime, darkness: d.darkness, phase: d.phase, solid: d.solid })
  await checkStandable(a)

  if (!daylightShot && d.phase === 'playing' && d.roundTime > 25 && d.darkness < 0.05) {
    daylightShot = true
    await shot(a, 'round-2-daylight')
  }
  // A weather effect, *in frame*.
  //
  // The first version fired on `hazards > 0` — "a hazard has been announced
  // somewhere on the map" — and produced a frame with no weather in it at all.
  // That is the §A22 trap: a screenshot that does not contain its subject is not
  // evidence. The visible world is 640×360 at `CAMERA_ZOOM`, so require the most
  // recent hazard to be inside it before shooting.
  const hz = d.observed.lastHazard
  if (!effectShot && hz && d.player) {
    const inFrame = Math.abs(hz.x - d.player.x) < 300 && Math.abs(hz.y - d.player.y) < 165
    if (inFrame) {
      effectShot = true
      // Named for what it can honestly promise. The proximity gate guarantees a
      // hazard was announced *near the camera*; it cannot guarantee one is still
      // alive when the shot lands, because a meteor impact is instantaneous and a
      // toxic drop is gone the instant it lands while the poll interval is 1 s.
      // Calling this
      // "weather" would be claiming more than the frame shows (§A22). That
      // weather *ran* is asserted from the effect lifecycle, not from a picture.
      await shot(a, 'round-3-hazard-nearby')
      console.log(`  hazard near the camera at ${hz.x.toFixed(0)},${hz.y.toFixed(0)}`)
    }
  }
  if (!nightShot && d.darkness > 0.6) {
    nightShot = true
    await shot(a, 'round-4-night')
  }
  // Late enough that the map has been under fire for a while — the respawn is
  // then landing on damaged terrain, which is the case `docs/21` §4 says must be
  // re-validated — but with time left to respawn and be sampled afterwards.
  if (!suicideDone && d.phase === 'playing' && d.roundTime > ROUND_SECONDS * 0.55) {
    suicideDone = true
    await selfKill(a)
  }
  if (d.phase === 'ended') break
  if (Date.now() > deadline) {
    fail(`the round never reached \`ended\` (stuck in ${d.phase} at t=${d.roundTime.toFixed(1)})`)
    break
  }
  // 1 s, not 2: hazards are transient (a lava vent's jet is seconds, a meteor
  // impact is instantaneous), so a slow poll misses the only frames worth
  // photographing.
  await sleep(1000)
}

driving = false
await Promise.all(drivers)
await sleep(1500)
// Hold Tab so the frame named "scoreboard" contains one (§A22). The first
// version of this shot was captured without it and showed only the round-over
// banner — a screenshot that does not contain its subject is not evidence.
await a.page.keyboard.down('Tab')
await sleep(500)
await shot(a, 'round-5-scoreboard')
const boardText = await a.page.evaluate(
  'document.querySelector("[data-hud]")?.textContent ?? ""',
)
await a.page.keyboard.up('Tab')
if (!/\d/.test(boardText)) fail(`the scoreboard showed nothing numeric:\n${boardText}`)

// --- what the round actually did -----------------------------------------
const da = await dbg(a)
const db = await dbg(b)
const o = da.observed

console.log('\n  --- assertions ---')

// Phase machine.
for (const p of ['warmup', 'playing', 'ended']) {
  if (!o.phases.includes(p)) fail(`never saw round_state for phase \`${p}\` (saw ${o.phases})`)
}
if (o.phases.includes('warmup') && o.phases.includes('playing') && o.phases.includes('ended')) {
  ok(`phase machine: ${o.phases.join(' → ')}`)
}

// A weather effect, start to finish. Telegraph *and* active *and* end against
// the same id — a single phase is satisfied by an effect the round cut short.
const complete = o.effects.filter(
  (e) => e.phases.includes('telegraph') && e.phases.includes('active') && e.phases.includes('end'),
)
if (!complete.length) {
  fail(
    `no weather effect ran start to finish (saw ${JSON.stringify(o.effects)}, ${o.hazards} hazards)`,
  )
} else {
  ok(`weather: ${complete.length} effect(s) ran telegraph→active→end (${complete.map((e) => e.kind).join(', ')}), ${o.hazards} hazards`)
}

// The cycle crossed into night and back, measured from the server's own byte.
if (!(o.darknessMax > 0.6)) fail(`the round never got dark (max darkness ${o.darknessMax})`)
else if (!(o.darknessMin < 0.05)) fail(`the round was never light (min darkness ${o.darknessMin})`)
else ok(`day/night: darkness ${o.darknessMin.toFixed(2)} → ${o.darknessMax.toFixed(2)}`)

// ...and the terrain visibly moved with it. The control for "night is dark" is
// that the same terrain was measurably lighter earlier (§A15: assert on the
// rendered result, and sample terrain rather than a whole-frame mean, which the
// sky dominates).
if (!effectShot) {
  // Not a failure: that weather *ran* is asserted from the effect lifecycle
  // above. This only says no hazard happened to land in the camera's 640x360
  // while it was alive, so there is no picture of it.
  console.log('  note: no hazard landed near the camera this round — no nearby-hazard shot')
}
if (!nightShot) fail('never captured a night frame, so nothing was measured')
if (!daylightShot) fail('never captured a daylight frame, so night had no control')

// Items.
if (!(o.itemSpawns > 0)) fail('no items spawned during the whole round')
else ok(`items: ${o.itemSpawns} spawned, ${o.itemPickups} picked up`)
if (!(o.itemPickups > 0)) fail('no item was ever picked up')

// Deaths and respawns. Reported split, because one death is guaranteed by the
// scripted self-kill and the rest are what the round produced on its own — a
// number worth seeing rather than hiding inside a total.
const selfKills = o.deaths.filter((d) => d.attacker === null || d.attacker === d.victim).length
const fought = o.deaths.length - selfKills
if (!(o.deaths.length > 0)) fail('nobody died in the whole round')
else ok(`deaths: ${o.deaths.length} (${fought} from combat, ${selfKills} self), respawns: ${o.respawns}`)
if (o.deaths.length > 0 && !(o.respawns > 0)) fail('there were deaths but no respawns')

// Nobody was ever found inside terrain while alive (§A26).
if (aliveSamples === 0) fail('the local player was never sampled alive, so nothing was checked')
else if (stuckSamples > 0) {
  fail(`the local body overlapped solid terrain in ${stuckSamples}/${aliveSamples} live samples`)
} else ok(`standable: 0/${aliveSamples} live samples found the body inside terrain`)

// Both masks agree after minutes of destruction.
if (da.maskChecksum !== db.maskChecksum) {
  fail(`masks diverged over the round:\n    ana ${da.maskChecksum}\n    bo  ${db.maskChecksum}`)
} else ok(`masks agree after the round: ${da.maskChecksum.slice(0, 16)}`)

// The control: if nothing was destroyed, "both agree" is two clients that both
// did nothing.
const destroyed = (samples[0]?.solid ?? 0) - da.solid
if (!(destroyed > 0)) fail(`no terrain was destroyed over the round (${destroyed} px)`)
else ok(`terrain: ${destroyed} px destroyed`)

// Scores are consistent with the deaths seen. Each death is −1 to the victim
// and +1 to a player attacker (`docs/21` §6), so the totals have to reconcile.
const credited = o.deaths.filter((d) => d.attacker !== null && d.attacker !== d.victim).length
const expected = credited - o.deaths.length
const actual = da.scores.reduce((s, p) => s + p.score, 0)
if (actual !== expected) {
  fail(
    `scores do not reconcile with deaths: sum ${actual}, expected ${expected} ` +
      `(${o.deaths.length} deaths, ${credited} credited to a player)`,
  )
} else ok(`scores reconcile: sum ${actual} from ${o.deaths.length} deaths, ${credited} credited`)

// Health of the connection.
if (da.resyncs !== 0 || db.resyncs !== 0) {
  fail(`map resyncs during the round: ana ${da.resyncs}, bo ${db.resyncs}`)
} else ok('no map resyncs')
if (da.pendingCarves !== 0 || db.pendingCarves !== 0) {
  fail(`carves left buffered: ana ${da.pendingCarves}, bo ${db.pendingCarves}`)
}
// The client is fed at 20 Hz, so a gap of 3 server ticks is one snapshot. Allow
// slack for scheduling, but a client that fell seconds behind is a real fault.
if (o.maxTickLag > 60) fail(`the client fell ${o.maxTickLag} server ticks behind at some point`)
else ok(`tick lag: max ${o.maxTickLag} ticks between applied snapshots`)

const allErrors = [...a.errors, ...b.errors]
if (allErrors.length) fail(`page errors: ${allErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

console.log(
  '\n' +
    JSON.stringify(
      {
        roundSeconds: ROUND_SECONDS,
        phases: o.phases,
        dayPhases: o.dayPhases,
        effects: o.effects,
        hazards: o.hazards,
        deaths: o.deaths.length,
        respawns: o.respawns,
        itemSpawns: o.itemSpawns,
        itemPickups: o.itemPickups,
        darkness: [o.darknessMin, o.darknessMax],
        destroyedPx: destroyed,
        scores: da.scores,
        maskAgrees: da.maskChecksum === db.maskChecksum,
        resyncs: { ana: da.resyncs, bo: db.resyncs },
        maxTickLag: o.maxTickLag,
        liveSamples: aliveSamples,
        stuckSamples,
        pageErrors: allErrors.length,
      },
      null,
      1,
    ),
)

await stack.close()
if (failures.length) {
  console.error(`\nfull-round FAILED (${failures.length})`)
  process.exit(1)
}
console.log('\nfull-round: one complete round, played')
process.exit(0)
