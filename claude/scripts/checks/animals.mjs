#!/usr/bin/env node
/**
 * T20.10 — there are animals on the ground, and you can see them.
 *
 *   node scripts/checks/animals.mjs
 *   node scripts/e2e.mjs animals
 *
 * ## Why a browser check when the lib tests already pass
 *
 * The same two failures `birds.mjs` exists for, one entity over: an animal the
 * server simulates and never announces is an animal nobody can shoot, and one
 * announced and never drawn is the same thing a layer further on. Both leave
 * every `game-core` test green — and `world::animals_in_a_round` already covers
 * everything that *is* visible from Rust: the drop, the cap, the warmup gate,
 * that they never attack, and that shooting one does not move a bird.
 *
 * So this checks the two things only a browser can: **both ends** (§A39) — what
 * the server holds against what the layer drew — and then that the animal is on
 * the frame (§C2).
 *
 * ## The control is the layer toggle inside one frozen frame
 *
 * `birds.mjs` uses a control *frame* from before any bird has crossed in, which
 * works because birds enter off the edge. Ground animals are placed on the map
 * and the first one exists on the first playing tick, so there is no such window.
 * The toggle is better anyway, and `GameScene.setAnimalsVisible`'s own comment says
 * why: hiding the layer inside a **frozen** frame has no second instant to
 * disagree with, where two frames taken at different times differ by everything
 * that moved between them.
 *
 * ## Three instruments this deliberately does not use as the verdict
 *
 *  - **`debug().animals`, the mirror's count.** It is a *precondition* here and
 *    never the verdict: it is exactly as green for a feature that is announced,
 *    counted and drawn nowhere, which is the failure this file exists for.
 *  - **A control frame from before the animals arrive.** `birds.mjs` can take
 *    one; there is no such window on the ground, and two frames from different
 *    instants differ by everything that moved between them — a hopping spider
 *    included.
 *  - **Counting heals on the ground after a kill.** `step_item_spawns` puts
 *    medkits and batteries out on a timer of its own, so that number is not
 *    attributable to the kill. The drop is asserted in
 *    `world::animals_in_a_round`, from the events at the killing tick, which is
 *    the only place that tick is visible.
 *
 * And a fourth, for the same reason as the first: **not** a texture-key or
 * child-count assertion on the layer. Both hold for a container that was built
 * correctly and never added to the display list.
 */
import { startStack, enterBattle, tally, sleep } from './harness.mjs'
import { samplePatch, colourDelta } from './pixels.mjs'

const PORT = 3137
const { fail, ok, finish } = tally('animals')

const stack = await startStack({
  port: PORT,
  label: 'animals',
  env: {
    FIXED_SEED: '4242',
    MAP_SCALE: 'small',
    ROUND_SECONDS: '240',
    // No bots: a bot's stray rocket killing one would change the counts this
    // check compares — `birds.mjs` and `death.mjs` both record that.
    BOT_COUNT: '0',
    // Nothing that repaints the whole frame while a small patch is measured.
    WEATHER: 'off',
  },
})

const { page, dbg, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'animals' })
const c = await page.evaluate(() => window.__game.constants())

/** World → screen, the §A35-correct way: `worldView` and zoom, never scrollX. */
const screenPos = (d, at) => {
  if (!d.worldView) throw new Error('debug() reports no worldView')
  return {
    sx: (at.x - d.worldView.x) * d.zoom,
    sy: (at.y - d.worldView.y) * d.zoom,
  }
}

/**
 * Stop the scene and let the renderer catch up to it.
 *
 * `freeze` pauses `update`, not rendering, so the scene graph stops while the
 * last rasterised frame can still be older. Two `requestAnimationFrame`s after
 * the pause is one full render of the stopped scene — `birds.mjs` measured a
 * patch changing 15.5 standalone and 0.0 under suite load without this.
 */
const settle = () =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

const freezeAndSettle = async () => {
  await page.evaluate(() => window.__game.freeze(true))
  await settle()
}

// --- both ends --------------------------------------------------------------
//
// The server's count as this client heard it, against what the layer drew. Two
// numbers that must agree; either alone is satisfied by a half-wired feature.
let d = null
for (let i = 0; i < 60; i++) {
  d = await dbg()
  if ((d.animals ?? 0) > 0) break
  await sleep(500)
}
if (!d || (d.animals ?? 0) === 0) {
  fail(
    `no animal was announced in ${(c.ANIMAL_INTERVAL * 2).toFixed(0)}s of a live round — ` +
      'the server either never spawned one or never told the client',
  )
} else {
  ok(`the server announced ${d.animals} animal(s), cap ${c.ANIMAL_MAX}`)
  if (d.animalsDrawn !== d.animals) {
    fail(
      `the mirror holds ${d.animals} animal(s) and the layer drew ${d.animalsDrawn} — ` +
        'announced and not drawn is a hillside nobody can shoot at',
    )
  } else ok(`the layer drew all ${d.animalsDrawn} of them`)
  if ((d.animals ?? 0) > c.ANIMAL_MAX) fail(`${d.animals} animals against a cap of ${c.ANIMAL_MAX}`)
}

// --- is the instrument alive? -----------------------------------------------
//
// The verdict below is "hide the layer inside a frozen frame and the patch
// changes". Its failure mode on a loaded box is not a wrong answer, it is a
// **confident** wrong answer: `samplePatch` reads the last rasterised frame, so
// if the renderer is behind, hiding *anything* moves nothing — which reads
// exactly like an animal that was never drawn. `rematch.mjs`'s branch for "the
// CONTROL frame is frozen too, so the leaver's frame proves nothing" is this
// same shape one check over, and it is why that check does not lie under load.
//
// So, before touching an animal: freeze on the **player**, who is on screen by
// construction because the camera follows them, hide the actors and confirm the
// patch moves. A dead instrument is reported as a dead instrument.
const PAD = 8
let instrumentAlive = null
{
  await freezeAndSettle()
  const dd = await dbg()
  const me = (dd.drawnPlayers ?? []).find((p) => p.id === dd.me) ?? (dd.drawnPlayers ?? [])[0]
  if (!me) {
    fail('no drawn player to calibrate the instrument against')
  } else {
    const s = screenPos(dd, me)
    const patch = {
      x: Math.round(s.sx - (c.PLAYER_W / 2) * dd.zoom - PAD),
      y: Math.round(s.sy - (c.PLAYER_H / 2) * dd.zoom - PAD),
      w: Math.round(c.PLAYER_W * dd.zoom + PAD * 2),
      h: Math.round(c.PLAYER_H * dd.zoom + PAD * 2),
    }
    const withActor = await samplePatch(page, patch)
    await page.evaluate(() => window.__game.setActorsVisible(false))
    await settle()
    const withoutActor = await samplePatch(page, patch)
    await page.evaluate(() => window.__game.setActorsVisible(true))
    await settle()
    const delta = colourDelta(withActor, withoutActor)
    instrumentAlive = delta >= 3
    console.log(
      `  calibration: hiding the player moved its own patch ${delta.toFixed(1)} ` +
        `(${instrumentAlive ? 'the rasteriser answers a toggle' : 'STALLED'})`,
    )
    if (!instrumentAlive) {
      fail(
        `hiding the player changed its own patch by ${delta.toFixed(1)} pixels — the renderer ` +
          'is not answering a visibility toggle at all, so nothing photographed below is ' +
          'attributable to the animals',
      )
    } else ok('the pixel instrument answers a toggle inside a frozen frame')
  }
  await page.evaluate(() => window.__game.freeze(false))
}

// --- the pixels -------------------------------------------------------------
const sizeOf = (kind) =>
  kind === 1 ? { w: c.BEETLE_W, h: c.BEETLE_H } : { w: c.SPIDER_W, h: c.SPIDER_H }

const fitsInFrame = (dd, a) => {
  const p = screenPos(dd, a)
  const { w, h } = sizeOf(a.kind)
  const halfW = (w / 2) * dd.zoom + PAD
  const halfH = (h / 2) * dd.zoom + PAD
  return p.sx - halfW >= 0 && p.sx + halfW <= 1280 && p.sy - halfH >= 0 && p.sy + halfH <= 720
}

// **Point the camera at one.** An animal is placed wherever the map has ground,
// the view is 640 world px of a 2048 px map, and the player is somewhere else —
// so waiting for one to wander into frame is waiting on a coincidence. `watch`
// is the e2e affordance for exactly this (§C2), and it is what `crates.mjs` uses
// for a supply drop that falls faster than the rig follows.
//
// The **drawn** position, not the mirror's: a patch computed from mirror
// coordinates and then screenshotted compares two instants, and a hopping spider
// can leave the patch between them.
let target = null
let frozen = null
let seenAny = 0
for (let i = 0; i < 60; i++) {
  const probe = await dbg()
  const drawn = probe.animalsDrawnAt ?? []
  seenAny += drawn.length
  if (drawn.length > 0) {
    const pick = drawn[0]
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [pick.x, pick.y])
    await sleep(120)
    await freezeAndSettle()
    frozen = await dbg()
    const still = (frozen.animalsDrawnAt ?? []).filter((a) => fitsInFrame(frozen, a))
    if (still.length > 0) {
      target = still[0]
      break
    }
    await page.evaluate(() => window.__game.freeze(false))
  }
  await sleep(200)
}

if (!target) {
  fail(
    `no animal could be framed — ${seenAny} drawn positions seen across the window, and ` +
      'none of them was wholly on screen after pointing the camera at it',
  )
} else {
  const s = screenPos(frozen, target)
  const { w, h } = sizeOf(target.kind)
  const patch = {
    x: Math.round(s.sx - (w / 2) * frozen.zoom - PAD),
    y: Math.round(s.sy - (h / 2) * frozen.zoom - PAD),
    w: Math.round(w * frozen.zoom + PAD * 2),
    h: Math.round(h * frozen.zoom + PAD * 2),
  }
  // **The control region**: the same-sized patch, well away from the animal and
  // from every other one, on the same frozen frame. If it moves too, the frame
  // is changing everywhere and nothing is attributable.
  const away = { ...patch, x: Math.max(0, Math.min(1280 - patch.w, patch.x + 300)) }
  const controlHasAnimal = (frozen.animalsDrawnAt ?? []).some((a) => {
    const p = screenPos(frozen, a)
    return (
      p.sx >= away.x - 20 && p.sx <= away.x + away.w + 20 && p.sy >= away.y - 20 && p.sy <= away.y + away.h + 20
    )
  })

  const withAnimal = await samplePatch(page, patch)
  const controlBefore = await samplePatch(page, away)
  // Hide the layer **inside the frozen frame**: same instant, one thing removed.
  await page.evaluate(() => window.__game.setAnimalsVisible(false))
  await settle()
  const without = await samplePatch(page, patch)
  const controlAfter = await samplePatch(page, away)
  await page.evaluate(() => window.__game.setAnimalsVisible(true))
  await page.evaluate(() => window.__game.freeze(false))
  await page.evaluate(() => window.__game.watch(null))

  const moved = colourDelta(withAnimal, without)
  const controlMoved = controlHasAnimal ? 0 : colourDelta(controlBefore, controlAfter)
  console.log(
    `  a ${target.kind === 1 ? 'beetle' : 'spider'} at ${patch.x},${patch.y}: hiding the layer ` +
      `moved the patch ${moved.toFixed(1)}, control ${controlMoved.toFixed(1)}` +
      (controlHasAnimal ? ' (control region held another animal; skipped)' : ''),
  )
  if (moved < 3) {
    // Which of the two it is, said out loud. The calibration above is the only
    // thing that separates "the animal is not drawn" from "this box is not
    // drawing"; without it the message below is a guess stated as a finding.
    fail(
      instrumentAlive
        ? `hiding the animal layer changed its own patch by ${moved.toFixed(1)} pixels, while ` +
            'hiding the player moved its patch on the same box — the animal is announced, ' +
            'counted and not on the screen'
        : `hiding the animal layer changed its own patch by ${moved.toFixed(1)} pixels, and so ` +
            'did hiding the player — the renderer stalled and this says nothing about animals',
    )
  } else if (controlMoved >= moved) {
    fail(
      `the control region moved ${controlMoved.toFixed(1)} against the animal's ` +
        `${moved.toFixed(1)} — the frame is changing everywhere`,
    )
  } else {
    ok(`the animal is on the frame: its patch moved ${moved.toFixed(1)} when the layer went away`)
  }
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
