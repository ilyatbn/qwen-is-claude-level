#!/usr/bin/env node
/**
 * T15.04 / §C16 — birds are in the sky, and shooting one opens a supply line.
 *
 *   node scripts/checks/birds.mjs
 *   node scripts/e2e.mjs birds
 *
 * ## Why a browser check when 20 lib tests already pass
 *
 * Because §C16 says birds are **not decoration** — they drop items — and the two
 * ways that claim fails are both invisible to `game-core`. A bird the server
 * simulates and never announces is a bird nobody can shoot; a bird announced and
 * never drawn is the same thing one layer further on. Both leave every lib test
 * green. So this counts birds at **both ends** (§A39) — what the server holds
 * against what the layer drew — and then asserts the bird is on the frame (§C2).
 *
 * ## The control frame
 *
 * The task asks for one in as many words: "a bird is visible in flight, with a
 * control frame before it spawns". Birds enter off the edge of the map, so there
 * is a real window at the start of a round with none on screen. That window is
 * the control, and it is a *frame* rather than a region because a bird crosses
 * the whole sky and no fixed rectangle is guaranteed to be free of it.
 *
 * ## Why the sky patch and not a fixed box
 *
 * The patch is derived from where the client says the bird actually is. A
 * hardcoded rectangle is a statement about one seed's flight draw, and the
 * altitude is drawn from the map's median surface — which moves with the
 * generator.
 */
import { join } from 'node:path'
import {
  startStack,
  enterBattle,
  standStill,
  selectWeapon,
  tally,
  sleep,
  shotsDir,
} from './harness.mjs'
import { samplePatch, colourDelta } from './pixels.mjs'

const PORT = 3134
const { fail, ok, finish } = tally('birds')

// No bots: a bot's stray rocket killing a bird would change the counts this
// check compares, the way `death.mjs` found for attribution. FIXED_SEED so the
// flight band is the same every run.
const stack = await startStack({
  port: PORT,
  label: 'birds',
  env: {
    FIXED_SEED: '4242',
    MAP_SCALE: 'small',
    ROUND_SECONDS: '240',
    BOT_COUNT: '0',
    DEV_LOADOUT: '1',
  },
})

const { page, dbg, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'birds' })

const start = await dbg()
// Not the seed: `core.meta.seed` is this client's *local* core, which in a
// networked round never generates the map — it is handed the mask. Reporting it
// as the map's seed is how a debug line becomes a lie.
ok(`in a round on a ${start.mapW}x${start.mapH} map`)

// --- the control frame ------------------------------------------------------
//
// Before any bird has crossed into view. `birds` is the server's count as this
// client heard it; if one is already here the control is void and this says so
// rather than quietly measuring nothing.
if (start.birds > 0) {
  ok(`note: ${start.birds} bird(s) already announced at join; the sky control is taken later`)
}
const controlShot = await page.screenshot()
await page.screenshot({ path: join(shotsDir, 'birds-control.png') })
// Where every bird was when that frame was taken. The patch assertion below
// compares one region across the two frames, so it is only a control if no bird
// was in that region *then* — asserted, not hoped for.
const controlBirds = (await dbg()).birdViews ?? []

// --- wait for a bird to be genuinely on screen ------------------------------
//
// Poll rather than sleep a fixed time: a bird enters off the map edge and takes
// `map_w / BIRD_SPEED` to reach the middle, and a hardcoded wait against that is
// a test that expires the moment either constant moves (CLAUDE.md).
const c = await page.evaluate(() => {
  const k = window.__game.constants()
  return {
    BIRD_SPEED: k.BIRD_SPEED,
    BIRD_MAX: k.BIRD_MAX,
    BIRD_INTERVAL: k.BIRD_INTERVAL,
    BIRD_W: k.BIRD_W,
    BIRD_H: k.BIRD_H,
    SMG_RANGE: k.SMG_RANGE,
    ITEM_MEDKIT: k.ITEM_MEDKIT,
    ITEM_BATTERY_PACK: k.ITEM_BATTERY_PACK,
  }
})
// Enough for a bird to cross from the edge into the camera, plus one cadence in
// case the first draw entered from the far side.
const budgetMs = ((start.mapW / c.BIRD_SPEED) * 1000 + c.BIRD_INTERVAL * 1000) * 1.2

/** World -> screen, the §A35-correct way: `worldView` and zoom, never scrollX. */
const screenPos = (d, world) => {
  if (!d.worldView) {
    throw new Error(
      'debug() reports no worldView — this converter cannot succeed, so every ' +
        'framing decision built on it is "off camera" regardless of the truth',
    )
  }
  const sx = (world.x - d.worldView.x) * d.zoom
  const sy = (world.y - d.worldView.y) * d.zoom
  return sx > 0 && sx < 1280 && sy > 0 && sy < 720 ? { sx, sy } : null
}

let onScreen = null
const deadline = Date.now() + budgetMs
while (Date.now() < deadline) {
  const d = await dbg()
  const inView = (d.birdViews ?? []).filter((b) => screenPos(d, b) !== null)
  onScreen = { birds: d.birds, drawn: d.birdsDrawn, kinds: d.birdKinds, inView, d }
  if (inView.length > 0) break
  await sleep(400)
}

if (!onScreen || onScreen.inView.length === 0) {
  fail(`no bird entered the camera within ${(budgetMs / 1000).toFixed(0)}s`)
} else {
  ok(`a bird is in the camera: ${onScreen.inView.length} of ${onScreen.birds} announced`)
}

// --- both ends --------------------------------------------------------------
if (onScreen && onScreen.birds !== onScreen.drawn) {
  fail(
    `the server announced ${onScreen.birds} bird(s) and the layer drew ${onScreen.drawn} — ` +
      'one end is lying',
  )
} else if (onScreen) {
  ok(`both ends agree: ${onScreen.birds} announced, ${onScreen.drawn} drawn`)
}
if (onScreen && onScreen.birds > c.BIRD_MAX) {
  fail(`${onScreen.birds} birds alive, cap is ${c.BIRD_MAX}`)
} else if (onScreen) {
  ok(`within the cap (${onScreen.birds} <= ${c.BIRD_MAX})`)
}

// --- the frame (§C2) --------------------------------------------------------
//
// The patch is placed on the bird the client says is on screen, in screen space,
// and compared against the same patch in the control frame. The sky is a
// gradient that also animates with the day cycle, so the delta has to clear what
// the sky does on its own — which is what the second control below measures.
if (onScreen && onScreen.inView.length > 0) {
  // **Re-read immediately before the shot.** The first version computed the
  // patch from the poll's `dbg()` and screenshotted afterwards; a bird covers
  // BIRD_SPEED px/s, so by the time the frame was taken it had left its own
  // patch and the delta read 3.3. Position and frame have to be the same moment.
  const dNow = await dbg()
  const target = (dNow.birdViews ?? []).find((b) => screenPos(dNow, b) !== null)
  if (!target) fail('the bird left the camera before it could be photographed')
  const d = dNow
  const s = screenPos(d, target)
  const pad = 10
  const patch = {
    x: Math.round(s.sx - (c.BIRD_W / 2) * d.zoom - pad),
    y: Math.round(s.sy - (c.BIRD_H / 2) * d.zoom - pad),
    w: Math.round(c.BIRD_W * d.zoom + pad * 2),
    h: Math.round(c.BIRD_H * d.zoom + pad * 2),
  }

  // The control frame is only a control if this patch held no bird when it was
  // taken. Checked against the recorded positions rather than assumed.
  const contaminated = controlBirds.some((b) => {
    const p = screenPos(d, b)
    return (
      p &&
      p.sx >= patch.x &&
      p.sx <= patch.x + patch.w &&
      p.sy >= patch.y &&
      p.sy <= patch.y + patch.h
    )
  })
  if (contaminated) {
    fail('a bird was already inside this patch in the control frame — it is not a control')
  } else {
    ok('control: no bird was in this patch when the control frame was taken')
  }

  const flightShot = await page.screenshot({ path: join(shotsDir, 'birds-in-flight.png') })
  // Did it stay inside the patch while the frame was taken? If not, the delta
  // below is measuring an empty box and would fail for the wrong reason.
  const after = await dbg()
  const moved = (after.birdViews ?? []).find((b) => b.id === target.id)
  if (moved) {
    const drift = Math.hypot(moved.x - target.x, moved.y - target.y)
    if (drift > c.BIRD_W) {
      fail(`the bird drifted ${drift.toFixed(0)} px while the frame was taken — patch is stale`)
    } else {
      ok(`the bird held still enough for the frame (drifted ${drift.toFixed(0)} px)`)
    }
  }
  // **The same rectangle, before and after the bird occupies it, with the
  // camera proven still.**
  //
  // Two earlier versions of this assertion were wrong, and the second was worse
  // than the first because it passed:
  //
  //   1. Same rect across two frames taken minutes apart — the camera had
  //      settled in between, so the rect was a different piece of world and the
  //      delta collapsed to 3.3.
  //   2. Bird's rect against empty sky beside it on one frame. Falsified by
  //      making the layer draw nothing: it still read **40.7**, because the
  //      bird's rect contained terrain and the sky beside it did not. It was
  //      measuring the skyline.
  //
  // What actually isolates the bird is the same rect on two frames with nothing
  // else changed: the bird is in it, then it has flown on. The camera is
  // asserted still between them rather than assumed, and a far-off rect is
  // sampled on both frames as the control for anything global (the day cycle).
  const CONTROL_RECT = { x: 40, y: 40, w: 120, h: 90 }

  const withBird = await samplePatch(page, patch, flightShot)
  const globalBefore = await samplePatch(page, CONTROL_RECT, flightShot)
  const viewBefore = d.worldView

  // Wait for it to leave its own rect — derived from BIRD_SPEED, not a guess.
  const clearMs = ((c.BIRD_W * 3) / c.BIRD_SPEED) * 1000 + 400
  let leftIt = false
  const leaveBy = Date.now() + clearMs * 3
  while (Date.now() < leaveBy) {
    const now = await dbg()
    const still = (now.birdViews ?? []).find((b) => b.id === target.id)
    const p = still ? screenPos(now, still) : null
    const inside =
      p && p.sx >= patch.x && p.sx <= patch.x + patch.w && p.sy >= patch.y && p.sy <= patch.y + patch.h
    if (!inside) {
      leftIt = true
      break
    }
    await sleep(150)
  }
  if (!leftIt) fail('the bird never left its own patch, so there is no control frame')

  const dAfter = await dbg()
  const emptyShot = await page.screenshot({ path: join(shotsDir, 'birds-patch-empty.png') })
  const viewAfter = dAfter.worldView
  const cameraMoved =
    Math.abs(viewBefore.x - viewAfter.x) + Math.abs(viewBefore.y - viewAfter.y)
  if (cameraMoved > 1) {
    fail(
      `the camera moved ${cameraMoved.toFixed(1)} px between the two frames — this rect is ` +
        'no longer the same piece of world, so the comparison means nothing',
    )
  } else {
    ok('the camera held still between the two frames')
  }

  // No other bird wandered into the rect in the meantime.
  const stillOccupied = (dAfter.birdViews ?? []).some((b) => {
    const p = screenPos(dAfter, b)
    return p && p.sx >= patch.x && p.sx <= patch.x + patch.w && p.sy >= patch.y && p.sy <= patch.y + patch.h
  })
  if (stillOccupied) fail('another bird moved into the rect — the control frame is not empty')

  const withoutBird = await samplePatch(page, patch, emptyShot)
  const globalAfter = await samplePatch(page, CONTROL_RECT, emptyShot)

  const birdDelta = colourDelta(withBird, withoutBird)
  const globalDelta = colourDelta(globalBefore, globalAfter)
  ok(
    `the bird's own rect changed ${birdDelta.toFixed(1)} when it flew on; ` +
      `a far-off control rect changed ${globalDelta.toFixed(1)}`,
  )
  if (birdDelta < 6) {
    fail(
      `the rect the bird was in changed only ${birdDelta.toFixed(1)} when it left — ` +
        'nothing was drawn there',
    )
  } else if (birdDelta <= globalDelta * 2) {
    fail(
      `the bird's rect changed ${birdDelta.toFixed(1)} and an unrelated rect changed ` +
        `${globalDelta.toFixed(1)} — that is the whole frame moving, not a bird`,
    )
  } else {
    ok('a bird is drawn: its rect changed far more than the frame did on its own')
  }
}

// --- shoot one, and watch the supply line open ------------------------------
//
// The reward is the whole point of §C16, and it is the half no lib test can see
// end to end: the drop has to reach this client as an item it can pick up.
if (onScreen && onScreen.inView.length > 0) {
  // Which items exist *before* the shot, by id. A bare count is not enough: the
  // periodic spawner puts heals and batteries out on a timer, so "more items
  // than before" is satisfied by a bird that dropped nothing (§A15). The drop is
  // identified by being a **new id at the place the bird died**.
  const before = new Set(
    ((await dbg()).mirrorItems ?? []).map((i) => i.id),
  )
  // --- get the player somewhere with sky -----------------------------------
  //
  // Measured, not assumed: on the first working run 39 of 40 attempts were
  // blocked by terrain. A bird flies at an altitude relative to the map's median
  // surface, and a player who spawned under an overhang has no line to any of
  // them, from anywhere they can stand. The jetpack is the game's own answer to
  // that, and using it is what a player would do.
  //
  // Climb until the column overhead is open, or the fuel runs out — and say
  // which, rather than failing later with "the bird is still flying".
  const skyOverhead = async () =>
    page.evaluate(() => {
      const g = window.__game
      const me = g.debug().player
      const core = g.core
      for (let y = Math.round(me.y) - 20; y > 0; y -= 2) {
        if (core.solidAt(Math.round(me.x), y)) return false
      }
      return true
    })

  if (!(await skyOverhead())) {
    for (let i = 0; i < 6 && !(await skyOverhead()); i++) {
      await page.keyboard.down('w')
      await sleep(700)
      await page.keyboard.up('w')
      await sleep(400)
    }
  }
  const clearAbove = await skyOverhead()
  if (clearAbove) ok('the player has open sky overhead')
  else ok('note: the column overhead is still roofed; falling back to whatever line exists')

  await standStill(page)
  // **The SMG, not the bazooka.** A rocket is a ballistic projectile: fired at a
  // bird 200 px up it arcs into the ground long before it gets there, and eight
  // attempts produced eight craters. Hitscan is instant and has no gravity, and
  // at `SMG_DAMAGE` 8 against `BIRD_HEALTH` 1 a single bullet is decisive.
  //
  // It is also the better path to exercise: `fire_hitscan` is where §C16 made
  // the ray march against each target's own hit box instead of a hardcoded
  // `PLAYER_W x PLAYER_H`, so this check covers the change rather than routing
  // around it.
  await selectWeapon(page, 'smg')

  // Retry on the effect, re-aiming each time: the bird is still moving between
  // the aim and the trigger, and a check that fires once and asserts is a gate
  // that fails on the draw rather than on the code (`ordnance.mjs`, same lesson).
  let killed = null
  let killedAt = { x: 0, y: 0 }
  let killedKind = 0
  let fired = 0
  let blockedBySight = 0
  let outOfRange = 0
  // **A deadline, not an attempt count.** A bird takes `map_w / BIRD_SPEED` to
  // cross — 29 s on this map — and the first version gave up after 16 s of
  // polling, which is not long enough for one to come round to a line the player
  // actually has. The budget is derived from the constants rather than picked, so
  // it does not expire when either moves.
  const shootBudgetMs = (start.mapW / c.BIRD_SPEED) * 1000 * 2.5
  const shootDeadline = Date.now() + shootBudgetMs
  while (killed === null && Date.now() < shootDeadline) {
    const d2 = await dbg()
    const me = d2.player
    // **Every bird in view, not just the first.** Up to `BIRD_MAX` are alive and
    // the one nearest the camera is often the one behind a ridge; taking the
    // first in the list threw away three quarters of the chances.
    const candidates = (d2.birdViews ?? [])
      .filter((b) => screenPos(d2, b) !== null)
      .sort(
        (a, b) =>
          Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y),
      )
    let target2 = null
    for (const cand of candidates) {
      const dd = Math.hypot(cand.x - me.x, cand.y - me.y)
      if (dd > c.SMG_RANGE) continue
      const los = await page.evaluate(
        ([from, to]) => {
          const core = window.__game.core
          const dx = to.x - from.x
          const dy = to.y - from.y
          const steps = Math.ceil(Math.hypot(dx, dy))
          for (let i = 1; i < steps; i++) {
            const x = Math.round(from.x + (dx * i) / steps)
            const y = Math.round(from.y + (dy * i) / steps)
            if (core.solidAt(x, y)) return false
          }
          return true
        },
        [{ x: me.x, y: me.y }, { x: cand.x, y: cand.y }],
      )
      if (los) {
        target2 = cand
        break
      }
    }
    if (!target2) {
      blockedBySight += 1
      await sleep(400)
      continue
    }
    const dist = Math.hypot(target2.x - me.x, target2.y - me.y)
    if (dist > c.SMG_RANGE) {
      // Out of range: wait for it to come closer rather than firing into space
      // and calling the miss a failure.
      outOfRange += 1
      await sleep(500)
      continue
    }
    // A small lead for the tick between aiming and the server resolving the
    // shot. Hitscan is instant, so this is one tick of travel, not a flight time.
    const lead = c.BIRD_SPEED * (1 / 60) * (target2.right ? 1 : -1)
    const aim = screenPos(d2, { x: target2.x + lead, y: target2.y })
    if (!aim) {
      await sleep(400)
      continue
    }
    await standStill(page)
    await page.mouse.move(aim.sx, aim.sy)
    await sleep(140)
    await page.evaluate('window.__game.fire()')
    fired += 1


    // Did that one land? Poll the bird rather than sleeping a fixed time.
    const until = Date.now() + 1200
    while (Date.now() < until) {
      const now = await dbg()
      if (!(now.birdViews ?? []).some((b) => b.id === target2.id)) {
        killed = target2.id
        killedAt = { x: target2.x, y: target2.y }
        killedKind = target2.kind
        break
      }
      await sleep(200)
    }
  }

  if (killed === null) {
    fail(
      `${(shootBudgetMs / 1000).toFixed(0)}s and every bird is still flying — ` +
        `${fired} shot(s) fired, ${blockedBySight} polls blocked by terrain, ` +
        `${outOfRange} out of range`,
    )
  } else {
    ok(`shot a bird down (id ${killed}) after ${fired} shot(s)`)
    // The drop has to fall and reach this client as an item it can see.
    let fresh = []
    const until = Date.now() + 8000
    while (Date.now() < until) {
      const now = await dbg()
      fresh = (now.mirrorItems ?? []).filter((i) => !before.has(i.id))
      if (fresh.length) break
      await sleep(300)
    }
    await page.screenshot({ path: join(shotsDir, 'birds-after-shot.png') })
    // The drop falls straight down from where the bird was (`BIRD_DROP_VELOCITY`
    // is vertical), so its column is the bird's. A periodic spawn lands on a
    // surface point and essentially never shares that column.
    const mine = fresh.filter((i) => Math.abs(i.x - killedAt.x) <= c.BIRD_W)
    if (mine.length === 0) {
      fail(
        `the bird died and no new item appeared in its column (x=${killedAt.x.toFixed(0)}); ` +
          `${fresh.length} unrelated item(s) did spawn, which is why a bare count ` +
          'would have passed here',
      )
    } else if (mine.length > 1) {
      fail(`one bird dropped ${mine.length} items`)
    } else {
      ok(
        `it dropped exactly one item (id ${mine[0].id}, item ${mine[0].item}) in the ` +
          `bird's own column, alongside ${fresh.length - 1} unrelated spawn(s)`,
      )
      // The kind decides the reward (§C16), and this asserts the pairing rather
      // than narrating it. Both ids cross from the registry, so a fixture
      // carrying `0` and `6` cannot drift away from the game (§A19).
      const want = killedKind === 1 ? c.ITEM_BATTERY_PACK : c.ITEM_MEDKIT
      const name = killedKind === 1 ? 'battery' : 'heal'
      if (mine[0].item === want) {
        ok(`a kind-${killedKind} bird dropped a ${name} (item ${want}), as §C16 says`)
      } else {
        fail(
          `a kind-${killedKind} bird should drop a ${name} (item ${want}) and dropped ` +
            `item ${mine[0].item}`,
        )
      }
    }
  }
}

if (pageErrors.length) fail(`page errors:\n${pageErrors.join('\n')}`)
else ok('no page errors')

await stack.close()
await finish()
