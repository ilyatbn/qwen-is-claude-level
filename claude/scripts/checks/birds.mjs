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
    BIRD_DROP_VELOCITY: k.BIRD_DROP_VELOCITY,
    GRAVITY: k.GRAVITY,
    BIRD_H: k.BIRD_H,
    SMG_RANGE: k.SMG_RANGE,
    SMG_MUZZLE_SPEED: k.SMG_MUZZLE_SPEED,
    ITEM_MEDKIT: k.ITEM_MEDKIT,
    ITEM_BATTERY_PACK: k.ITEM_BATTERY_PACK,
  }
})
// Enough for a bird to cross from the edge into the camera, plus one cadence in
// case the first draw entered from the far side.
const budgetMs = ((start.mapW / c.BIRD_SPEED) * 1000 + c.BIRD_INTERVAL * 1000) * 1.2

/** World -> screen, the §A35-correct way: `worldView` and zoom, never scrollX. */
/**
 * Stop the scene and let the renderer catch up to it.
 *
 * `freeze` pauses `update`, not rendering — so the scene graph stops moving but
 * the last *rasterised* frame can still be older than it. Under suite load
 * Phaser's update outpaces its render, and a patch computed from
 * `birdsDrawnAt` (which is `root.x`, a scene-graph position) then describes a
 * bird the screenshot has not drawn yet: measured, the rect changed 15.5
 * standalone and 0.0 inside the full suite on identical code, with the control
 * at 0.3 proving the frame itself was quiet.
 *
 * Two `requestAnimationFrame`s after the pause is one full render of the stopped
 * scene, after which the pixels and the positions describe the same instant.
 */
const freezeAndSettle = async () => {
  await page.evaluate(() => window.__game.freeze(true))
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
}

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
//
// **Converged, not sampled once.** The layer reconciles against the mirror in
// the scene's update, so it is legitimately up to one frame behind: a single
// read can catch a bird the server has announced and the layer has not drawn
// yet, and under load that window is wide — measured, "announced 2, drew 1" on
// a client that was drawing both a moment later. Polling until the two agree
// removes the frame, and **the comparison itself is unchanged**: they must be
// equal, and if they never become equal that is still a failure.
if (onScreen) {
  for (let i = 0; i < 40; i++) {
    const d = await dbg()
    const birds = (d.birdViews ?? []).length
    const drawn = d.birdsDrawn ?? 0
    onScreen.birds = birds
    onScreen.drawn = drawn
    if (birds === drawn) break
    await sleep(100)
  }
}
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
  // **Wait for a bird worth photographing, then freeze on it.**
  //
  // Freezing first only stops the clock wherever it happens to be, which is
  // usually a bird at the edge of the frame. So: poll while the world runs until
  // one is wholly in shot, and only then stop the scene.
  //
  // Freezing at all is because the patch is computed from a `dbg()` poll and the
  // screenshot is taken afterwards. A bird covers `BIRD_SPEED` px/s and under
  // suite load the gap between the two widens until it has left its own patch —
  // measured, the rect changed 20.9 standalone and 2.7 inside the full suite on
  // identical code, with the drift guard passing 11 px, a third of the patch at
  // `CAMERA_ZOOM` 2. `freeze` makes the position and the picture one instant,
  // and other checks already use it for exactly this.
  /**
   * Padding around the bird's own box, in screen px.
   *
   * A bird is `BIRD_W x BIRD_H` and the patch has to hold it plus the wing
   * animation and a little antialiasing. Named because it is read in three
   * places — the fit test, the patch, and the drift bound — and a literal in
   * three places is three chances to change two of them.
   */
  const PAD = 10

  const patchFitsIn = (dd, b) => {
    const p = screenPos(dd, b)
    if (!p) return false
    const halfW = (c.BIRD_W / 2) * dd.zoom + PAD
    const halfH = (c.BIRD_H / 2) * dd.zoom + PAD
    return p.sx - halfW >= 0 && p.sx + halfW <= 1280 && p.sy - halfH >= 0 && p.sy + halfH <= 720
  }

  /**
   * **In frame is not the same as visible.** A bird flying behind a hillside is
   * wholly on screen and wholly hidden, and toggling the layer then changes
   * nothing — which reads, at the assertion below, as "the layer draws nothing".
   *
   * Measured: after §E12 made rocks and bushes 50 % bigger, the bird this check
   * chose sat at world (1141, 390) with `solidAt` **true at its own centre and
   * at 121 of 121 samples in an 80 px box around it**. Buried, not missing. The
   * check had no way to say so because it only ever asked whether the bird was
   * inside the viewport.
   *
   * So the premise is "against open sky", asked of the same mask the renderer
   * draws from: the bird's own box, plus the patch's padding, entirely clear.
   * Terrain is what changed under this fixture, and this is the fixture saying
   * which situation it needs rather than assuming the map still provides it.
   */
  const clearOfTerrain = (b) =>
    page.evaluate(
      ([bx, by, hw, hh]) => {
        const core = window.__game.core
        for (let y = -hh; y <= hh; y += 4)
          for (let x = -hw; x <= hw; x += 4)
            if (core.solidAt(Math.round(bx + x), Math.round(by + y))) return false
        return true
      },
      [b.x, b.y, c.BIRD_W / 2 + PAD, c.BIRD_H / 2 + PAD],
    )

  let dNow = null
  let target = null
  let seenFramed = 0
  let seenFrozen = 0
  let buried = 0
  for (let i = 0; i < 80; i++) {
    const probe = await dbg()
    // **The DRAWN positions, not the mirror's.** `freeze` pauses the scene, so
    // the frame on screen is whichever one was last rendered while the mirror
    // keeps taking socket updates — a patch computed from mirror coordinates and
    // then screenshotted compares two instants. Measured, that read 20.9
    // standalone and 0.2 inside the full suite on identical code.
    const framed = (probe.birdsDrawnAt ?? []).filter((b) => patchFitsIn(probe, b))
    seenFramed += framed.length
    if (framed.length > 0) {
      await freezeAndSettle()
      // Re-read once stopped: the bird moved between the probe and the freeze,
      // and it is the frozen position the screenshot will show.
      dNow = await dbg()
      for (const b of (dNow.birdsDrawnAt ?? []).filter((x) => patchFitsIn(dNow, x))) {
        seenFrozen++
        if (await clearOfTerrain(b)) {
          target = b
          break
        }
        buried++
      }
      if (target) break
      await page.evaluate(() => window.__game.freeze(false))
    }
    await sleep(120)
  }
  if (!target) {
    // Fail rather than photograph one that cannot be seen. The counts separate
    // the three ways this ends with nothing to aim at, because "no bird" and
    // "every bird behind a hill" are different findings and the second one is
    // what §E12 produced.
    fail(
      `no bird was both wholly in frame and against open sky — ${seenFramed} framed, ` +
        `${seenFrozen} re-read while frozen, ${buried} of those buried in terrain`,
    )
  }

  const d = dNow
  const s = screenPos(d, target)
  const patch = {
    x: Math.round(s.sx - (c.BIRD_W / 2) * d.zoom - PAD),
    y: Math.round(s.sy - (c.BIRD_H / 2) * d.zoom - PAD),
    w: Math.round(c.BIRD_W * d.zoom + PAD * 2),
    h: Math.round(c.BIRD_H * d.zoom + PAD * 2),
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

  /**
   * **The same frozen frame, with the layer and without it.**
   *
   * Every earlier version compared two *instants* — the bird here, then the bird
   * gone — and each failed for its own reason:
   *
   *   1. Two frames minutes apart: the camera settled between them, the rect was
   *      a different piece of world, and the delta collapsed to 3.3.
   *   2. The bird's rect against sky beside it on one frame. Falsified by making
   *      the layer draw nothing: it still read **40.7**, because the rect held
   *      terrain and the sky beside it did not. It was measuring the skyline.
   *   3. Two frozen frames, patch computed from `birdsDrawnAt`. Passed
   *      standalone at 15.5 and failed under load at 0.0 — with 31,058 px of the
   *      frame changing elsewhere, so the two frames were far apart in time and
   *      the coordinates, read from scene state, described neither picture.
   *
   * Toggling the layer inside **one** frozen frame has no second instant to
   * disagree with. The camera cannot move, the clouds cannot drift, and the only
   * difference between the two images is the birds — so whatever changes *is*
   * the bird, wherever the renderer chose to put it. This is how `living-sky`
   * measures the parallax band, for the same reason.
   */
  /**
   * A rect far from the bird, sampled on both images.
   *
   * With the layer toggled inside one frozen frame this is no longer a noise
   * floor — the two images are the same instant, so an unchanged region is
   * bit-identical and this should read **0.0**. `objects` measures exactly that
   * with a different instrument. Any non-zero value means something outside the
   * bird layer moved between two screenshots that were supposed to be one frame,
   * and that is worth investigating rather than absorbing by raising a number.
   */
  /**
   * A region no bird ever enters, sampled in the same two frames.
   *
   * **On a frozen frame this has changed job.** It used to be a noise floor —
   * how much the sky churns on its own — but the frames either side of the
   * toggle are now the *same* frozen frame, so the sky, the clouds and the
   * weather are all still. It reads ~0.1, and `objects.mjs` measured 0.00 for
   * the same reason with a different instrument: a frozen frame is
   * bit-deterministic.
   *
   * So this is a **determinism self-test**, not a threshold. Any non-zero value
   * means something in the frame is genuinely moving, and the response is to
   * find what — never to raise a number to accommodate it.
   */
  const CONTROL_RECT = { x: 40, y: 40, w: 120, h: 90 }

  const flightShot = await page.screenshot({ path: join(shotsDir, 'birds-in-flight.png') })
  await page.evaluate(() => window.__game.setBirdsVisible(false))
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  const emptyShot = await page.screenshot({ path: join(shotsDir, 'birds-patch-empty.png') })
  const emptyShot2 = await page.screenshot()
  await page.evaluate(() => window.__game.setBirdsVisible(true))
  await page.evaluate(() => window.__game.freeze(false))

  /**
   * **Find the bird in the picture; do not predict where it should be.**
   *
   * With the layer toggled inside one frozen frame, the difference between the
   * two images *is* the birds — so the changed region is the bird, wherever the
   * renderer put it. Every version of this check that instead computed a rect
   * from state and sampled it has failed under load, because a coordinate read
   * from the scene graph and a screenshot of a rendered frame are two different
   * instants: 15.5 standalone against 0.0 under load, with the frame's own
   * control at 1.0 proving the images really did differ.
   *
   * This also makes the assertion stronger rather than weaker. It was "a patch I
   * chose changed"; it is now "a bird-sized region changed, and it is where the
   * state says the bird is" — the second half being the both-ends claim that a
   * predicted rect could only ever assume.
   */
  const globalBefore = await samplePatch(page, CONTROL_RECT, flightShot)
  const globalAfter = await samplePatch(page, CONTROL_RECT, emptyShot)

  const changedBetween = (b0, b1) =>
    page.evaluate(
    async ([b0, b1]) => {
      const load = async (b) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const cx = cv.getContext('2d')
        cx.drawImage(img, 0, 0)
        return { d: cx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height }
      }
      const A = await load(b0)
      const B = await load(b1)
      let minX = A.w
      let minY = A.h
      let maxX = -1
      let maxY = -1
      let n = 0
      for (let y = 0; y < A.h; y++) {
        for (let x = 0; x < A.w; x++) {
          const i = (y * A.w + x) * 4
          const dd =
            Math.abs(A.d[i] - B.d[i]) +
            Math.abs(A.d[i + 1] - B.d[i + 1]) +
            Math.abs(A.d[i + 2] - B.d[i + 2])
          if (dd > 30) {
            n++
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      // **No match is `null`, not the viewport.** These start at the image
      // bounds so the first match can shrink them, and if nothing ever matches
      // they stay inverted: `minX` 1280 against `maxX` -1. Returned as numbers
      // that reads as a full-screen box, and every arithmetic done on it
      // produces something plausible — the midpoint of that inverted rect is
      // (639.5, 359.5), which is the exact centre of the screen. That is how one
      // cause (nothing changed) printed as two failures, the second of which
      // looked like a coordinate bug in the renderer.
      if (n === 0) return { n: 0, box: null }
      return { n, box: { minX, minY, maxX, maxY } }
    },
      [b0.toString('base64'), b1.toString('base64')],
    )

  const seen = await changedBetween(flightShot, emptyShot)
  // **The null.** Two screenshots of the same frozen frame with the layer in the
  // same state: whatever changes between *those* is the floor, measured rather
  // than chosen. It should be 0, and if it is not, the frame is not as frozen as
  // this check believes.
  const nothing = await changedBetween(emptyShot, emptyShot2)

  const birdBox = { w: c.BIRD_W * d.zoom, h: c.BIRD_H * d.zoom }
  const where = seen.box
    ? `[${seen.box.minX}..${seen.box.maxX}]x[${seen.box.minY}..${seen.box.maxY}]`
    : 'nowhere — no pixel differed at all'
  ok(
    `hiding the bird layer changed ${seen.n} px in ${where}; the same frame differs ` +
      `from itself by ${nothing.n} px`,
  )

  // **Against the measured null, not a chosen number.** A bird is thin — an
  // ellipse and two triangles — so it changes far fewer pixels than its own
  // bounding box: 90 against 1120 at zoom 2, measured. A floor derived from that
  // box would fail a bird that is plainly drawn, which is what a picked
  // threshold does.
  if (seen.n <= Math.max(nothing.n * 3, 1)) {
    fail(
      `hiding the bird layer changed ${seen.n} px against a frozen frame that differs ` +
        `from itself by ${nothing.n} — nothing is being drawn`,
    )
  } else if (
    seen.box.maxX - seen.box.minX > birdBox.w * 3 ||
    seen.box.maxY - seen.box.minY > birdBox.h * 3
  ) {
    // The other control: if the changed region is far larger than a bird, the
    // two images are not one frozen frame and this is not measuring a bird.
    fail(
      `hiding the bird layer changed a ${seen.box.maxX - seen.box.minX}x${seen.box.maxY - seen.box.minY} ` +
        `region against a bird's own ${Math.round(birdBox.w)}x${Math.round(birdBox.h)} — ` +
        'the frame is not frozen',
    )
  } else {
    ok('a bird is drawn: hiding the layer removed a bird-sized region and nothing else')
  }

  // ...and it is where the state says it is. This is the both-ends half: the
  // layer drew something bird-sized, and it drew it at the position the debug
  // handle reports, within one bird's width.
  const predicted = screenPos(d, target)
  // Guarded rather than computed unconditionally: with no changed region there
  // is no centre, and the midpoint of the old inverted box was (639.5, 359.5) —
  // the middle of the screen, and a number a reader accepts at a glance. This
  // assertion is downstream of the one above, so if that failed this says so
  // instead of inventing a second, different-looking failure from one cause.
  if (!seen.box) {
    fail('no changed region, so there is no drawn position to compare — see above')
  } else {
    const cx = (seen.box.minX + seen.box.maxX) / 2
    const cy = (seen.box.minY + seen.box.maxY) / 2
    const off = Math.hypot(cx - predicted.sx, cy - predicted.sy)
    if (off > c.BIRD_W * d.zoom) {
      fail(
        `the drawn bird is centred at (${cx.toFixed(0)}, ${cy.toFixed(0)}) but the state ` +
          `says (${predicted.sx.toFixed(0)}, ${predicted.sy.toFixed(0)}) — ${off.toFixed(0)} px apart`,
      )
    } else {
      ok(`drawn where the state says it is (${off.toFixed(0)} px apart)`)
    }
  }

  // The frame's own control, and with one frozen frame it is no longer a noise
  // floor: an unchanged region between two screenshots of the same instant is
  // bit-identical, so this should read 0.0 — `objects` measures exactly that
  // with a different instrument. A non-zero value means something outside the
  // bird layer moved between two images that were supposed to be one frame.
  const globalDelta = colourDelta(globalBefore, globalAfter)
  ok(`a far-off control rect changed ${globalDelta.toFixed(1)} across the layer toggle`)
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
  // attempts produced eight craters. An SMG round flies straight and ignores
  // gravity and wind (§F1), and at `SMG_DAMAGE` 8 against `BIRD_HEALTH` 1 a
  // single bullet is decisive.
  //
  // It is also the better path to exercise: §C16 made the hit test march against
  // each target's own box rather than a hardcoded `PLAYER_W x PLAYER_H`, and
  // §F1 carried that rule into the projectile step — a bird stops a bullet and
  // nothing else. This check covers both rather than routing around them.
  await selectWeapon(page, 'smg')

  // Retry on the effect, re-aiming each time: the bird is still moving between
  // the aim and the trigger, and a check that fires once and asserts is a gate
  // that fails on the draw rather than on the code (`ordnance.mjs`, same lesson).
  let killed = null
  let killedAt = { x: 0, y: 0 }
  /** How stale `killedAt` is, so the column tolerance can allow for it. */
  let killedStaleMs = 0
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
    // Lead the bird by the round's **flight time** (§F1).
    //
    // This was one tick of travel, and the comment said why: "hitscan is
    // instant". It is not any more — an SMG round covers `SMG_MUZZLE_SPEED`
    // px/s, so a bird 400 px away is half a second of flight and a one-tick lead
    // aims at where it was. Computed from the constants at both ends, so it
    // tracks the speed rather than expiring against it (§A19).
    const flight = dist / c.SMG_MUZZLE_SPEED
    const lead = c.BIRD_SPEED * flight * (target2.right ? 1 : -1)
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
    // **The freshest position, and how old it is.** `killedAt` was taken from
    // `target2` — the reading from before the shot was fired — so the bird had
    // been flying for the whole flight time by the time it died, and the drop
    // spawns where it *was* when it died. Tracking the last live sample and its
    // age lets the column tolerance below allow exactly the uncertainty the
    // sampling actually has, rather than a fixed 20 px that happens to work when
    // the box is quiet.
    let lastSeen = { x: target2.x, y: target2.y, t: Date.now() }
    while (Date.now() < until) {
      const now = await dbg()
      const still = (now.birdViews ?? []).find((b) => b.id === target2.id)
      if (!still) {
        killed = target2.id
        killedAt = { x: lastSeen.x, y: lastSeen.y }
        killedStaleMs = Date.now() - lastSeen.t
        killedKind = target2.kind
        break
      }
      lastSeen = { x: still.x, y: still.y, t: Date.now() }
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
    // How far the bird could have travelled since the last position we saw,
    // plus its own width. Derived from `BIRD_SPEED` and the measured staleness,
    // so it is as tight as the sampling allows and no tighter — under load the
    // poll period stretches and this stretches with it.
    const columnTolerance = c.BIRD_W + (c.BIRD_SPEED * killedStaleMs) / 1000
    ok(
      `looking for the drop within ${columnTolerance.toFixed(0)} px of x=` +
        `${killedAt.x.toFixed(0)} (last seen ${killedStaleMs} ms before it died)`,
    )
    /**
     * **Where an item was FIRST seen, not where it is now.**
     *
     * A bird drop spawns at the bird — high in the air — and falls; a periodic
     * spawn appears on a surface point, on the ground. That difference is the
     * only reliable discriminator available, because `world/mod.rs:1633` spawns
     * the drop with `SpawnSource::Periodic`, so the wire cannot tell them apart
     * (a finding in its own right). Column alone is not enough: with the
     * tolerance widened for sampling staleness, a periodic spawn landed inside
     * it and the check reported "one bird dropped 2 items".
     */
    const firstSeen = new Map()
    const killedAtMs = Date.now()
    /**
     * Did this item start where the bird died?
     *
     * Both axes. The vertical window is how far a drop could have fallen by the
     * time we first saw it — `BIRD_DROP_VELOCITY` plus gravity over the elapsed
     * time — so it is derived from the physics rather than picked, and it grows
     * exactly as fast as the uncertainty does.
     */
    const fromTheBird = (i) => {
      const at = firstSeen.get(i.id) ?? { x: i.x, y: i.y }
      if (Math.abs(at.x - killedAt.x) > columnTolerance) return false
      const t = Math.max(0, (Date.now() - killedAtMs) / 1000)
      const fell = c.BIRD_DROP_VELOCITY * t + 0.5 * c.GRAVITY * t * t
      return at.y >= killedAt.y - c.BIRD_H && at.y <= killedAt.y + fell + c.BIRD_H
    }
    // The drop has to fall and reach this client as an item it can see.
    let fresh = []
    const until = Date.now() + 8000
    while (Date.now() < until) {
      const now = await dbg()
      fresh = (now.mirrorItems ?? []).filter((i) => !before.has(i.id))
      for (const i of fresh) if (!firstSeen.has(i.id)) firstSeen.set(i.id, { x: i.x, y: i.y })
      // **Wait for the drop, not for any item.** This broke on the first new
      // item of any kind, and the world spawns items on a cadence of its own —
      // under load one of those arrives first, the loop stops looking, and the
      // bird's own drop is still falling when the assertion runs. Measured, the
      // failure names it: "1 unrelated item(s) did spawn". The column filter
      // below is the thing being waited for, so it is the thing to wait on.
      if (fresh.some((i) => fromTheBird(i))) break
      await sleep(300)
    }
    await page.screenshot({ path: join(shotsDir, 'birds-after-shot.png') })
    // The drop falls straight down from where the bird was (`BIRD_DROP_VELOCITY`
    // is vertical), so its column is the bird's. A periodic spawn lands on a
    // surface point and essentially never shares that column.
    const mine = fresh.filter((i) => fromTheBird(i))
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
