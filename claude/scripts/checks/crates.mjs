#!/usr/bin/env node
/**
 * T13.05 — a supply crate falls where you can see it fall, and can be picked up.
 *
 *   node scripts/checks/crates.mjs
 *   node scripts/e2e.mjs crates
 *
 * ## What was actually wrong
 *
 * The bug was reported as two — crates appear in mid-air, and crates cannot be
 * picked up — and the task assumed the crate never fell. Sampling first showed
 * the opposite: the simulation is correct. A crate spawns at `y = SKY_MARGIN/2`,
 * falls through the shared resolver, lands, and a player standing on it picks it
 * up. `cargo test -p game-core --lib crate` proves all of that and proved it
 * before this task changed a line.
 *
 * What did not exist was any way for a client to learn that the crate had moved
 * since it was created. `item_spawn` carries the position an item was *created*
 * at; nothing carried where it went. So every client drew the crate hanging at
 * y=48 for the rest of the round, and "cannot pick it up" meant "cannot pick it
 * up *there*" — the real crate was on the ground somewhere below, being taken by
 * whoever happened to walk over a patch of ground with nothing visible on it.
 *
 * One defect, two symptoms. Which is why this check asserts the two ends against
 * each other rather than either one alone: the drawn position, read back off the
 * live sprites, against the position the server reports. Before T13.05 those two
 * numbers disagreed by the height of the map and every existing test was green.
 *
 * ## Why a real server
 *
 * Crates arrive on `CRATE_INTERVAL` (35 s) during `Playing`, from the server's
 * spawn schedule. There is no sandbox path to one, and inventing a client-side
 * crate would test a code path no player ever runs.
 *
 * ## Reaching it
 *
 * The walker **flies**. Walking was enough until the room-on-demand change moved
 * the spawn draw: the crate landed on a shelf 300 px above the player, who spent
 * 70 s bunny-hopping at a wall and got no closer than 91 px against a
 * `PICKUP_RADIUS` of 20. Terrain between two random points is not a thing to
 * tune a fixture against — every player has a jetpack (`JETPACK_MAX_SPEED` 260
 * for `JETPACK_MAX_FUEL` 5 s is over a thousand pixels of climb), so the check
 * uses the same mechanism a player would.
 */
import { join } from 'node:path'
import { samplePatch } from './pixels.mjs'
import { startStack, enterBattle, tally, sleep, shotsDir } from './harness.mjs'

const PORT = 3116
const { fail, ok, failures } = tally('crates')

/**
 * Long enough for a crate (35 s) plus enough round left afterwards to fly to it
 * from wherever the spawn put us. A shorter round makes the pickup assertion a
 * race against the clock, which is a coin-flip gate rather than a gate.
 */
const ROUND_SECONDS = 140

/** How often the approach loop samples. The pickup tolerance is derived from it. */
const APPROACH_POLL_MS = 160

/**
 * The map this check is tuned against. **4242 -> 555 -> 7.**
 *
 * ## Re-probed after pass 6b (T16.02)
 *
 * Objects are stamped into the terrain now, so both properties below were
 * re-measured rather than assumed to survive. On 555 the crate is still reachable
 * in principle, but the approach loop walks into a stamped object and stops:
 * measured, pinned at (1641, 499) for 354 consecutive polls holding `a`, jetpack
 * firing, 199 px short of a crate at (1547, 324). The loop holds a direction and
 * jets — it is not a pathfinder, and scenery gives it far more to catch on.
 *
 * Re-probed the same way: 99 gets 830 px short, **7 takes the crate from 32 px**.
 * So 7. If a future map moves again, the two printed numbers — clear air and
 * closest approach — are still what to probe with, and `CRATE_SEED` is still the
 * way to do it without editing this file.
 *
 * Two things have to hold at once, and 4242 under `MAP_GENERATOR=v2` gives
 * neither:
 *
 *  - **Clear air under the crate.** The flight is photographed, then the crate
 *    has to fall further out of that same rect for the control frame. On 4242 the
 *    crate lands on a floating island 253 px below its spawn, and once the camera
 *    has been aimed and settled there are 45 px of flight left.
 *  - **A crate our client can walk to.** The approach loop holds a direction and
 *    jets in bursts; it is not a pathfinder, and on 31337 the crate lands across
 *    a mesa from the spawn. Measured: pinned at x=1440 for 20 s, 433 px short.
 *
 * Probed rather than guessed. Clear air under the crate: 4242 253 px, 7 508,
 * 99 635, **555 671**, 31337 943. Of those, 555 is the one whose crate is also
 * reachable. Overridable so the next person can probe the same way without
 * editing the file:
 *
 *   CRATE_SEED=99 node scripts/e2e.mjs crates
 *
 * A failure here is a fixture question before it is a bug: the check prints the
 * clear air it found and the closest approach it managed, which is what those two
 * numbers are for.
 */
const CRATE_SEED = process.env.CRATE_SEED ?? '7'

const stack = await startStack({
  port: PORT,
  label: 'crates',
  env: {
    ROUND_SECONDS: String(ROUND_SECONDS),
    // A fixed map, so where the crate lands and how far our client has to travel
    // to reach it are the same every run. Without it this check is a different
    // fixture each time and "the player could not reach it" becomes a coin flip
    // rather than a result — the mistake `terrain-render` already made once.
    FIXED_SEED: CRATE_SEED,
    // **No bots.** They used to be here to do the walking, because our client
    // could not reach the crate. It can now (it flies), and with bots in the
    // room "the crate stopped existing" is satisfied by a bot taking it 190 px
    // away from us — which is what the first run of this rewrite actually
    // recorded, while the failure message still said "our client flew at it".
    // One taker means the pickup asserted is the one performed.
    BOT_COUNT: '0',
  },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'crates' })
console.log(`  round ${ROUND_SECONDS}s`)

/**
 * Where a world point is on screen, or null if it is not.
 *
 * The camera follows the player and a crate spawns wherever it spawns, so most
 * of the time the crate is simply not in shot. A screenshot named
 * `crate-falling.png` that contains no crate is worse than no screenshot: it
 * looks like evidence. So every shot of the crate is taken only when the crate
 * is actually in frame, and the check says so when it is not (§A22).
 */
const screenPos = async (world) => {
  const d = await dbg()
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

/** The crate as the client draws it, and as the server reports it. */
const crateNow = async () => {
  const d = await dbg()
  const drawn = (d.drawnItems ?? []).find((i) => i.source === 'Crate')
  const mirror = (d.mirrorItems ?? []).find((i) => i.source === 'Crate')
  return { drawn, mirror, chutes: d.chutesDrawn ?? 0, d }
}

// --- wait for a crate -----------------------------------------------------
//
// Up to CRATE_INTERVAL plus the warmup. Polled at 250 ms: the fall is over in a
// couple of seconds and a slower poll photographs a crate already at rest, which
// is the state the bug also produced.
let seen = null
const samples = []
let sawChute = 0
let framedInFlight = false
let flightPos = null
/**
 * The patch the crate was photographed in, computed from its real screen
 * position. The control samples this same rect from this same camera point once
 * the crate has gone, so both frames show the same piece of world.
 */
let canopyRect = null
let canopy = null
let skyL = null
let skyR = null
/** How much a rect with nothing in it moved between the two frames. */
let quietDriftValue = 0
for (let i = 0; i < 260 && !seen; i++) {
  const c = await crateNow()
  if (c.mirror) seen = c
  else await sleep(250)
}
if (!seen) {
  fail(`no crate arrived in ${ROUND_SECONDS}s — CRATE_INTERVAL is ${35}s, so this is a real failure`)
} else {
  const id = seen.mirror.id
  ok(`crate ${id} spawned at y=${seen.mirror.y.toFixed(0)}`)

  // --- how far this crate is going to fall, before it falls ---------------
  //
  // Probed from the mask, not assumed. The framing altitude and the "it fell
  // further" distance below used to be the literals 130 and 140, chosen against
  // the map `FIXED_SEED=4242` produced at the time and carrying a comment saying
  // as much: "the altitude is a fixture choice about *this* seed". The seed did
  // not change; `MAP_GENERATOR=v2` changed what it builds. This crate lands on a
  // floating island 258 px below its spawn, so a 130 px entry plus 140 px of
  // further fall does not fit inside the flight, and two pixel assertions failed
  // for having nowhere to stand rather than for anything being wrong.
  //
  // The columns either side are probed too: the canopy patch sits 44 px left of
  // the crate at zoom 2 and its quiet control another 120 px left of that, so
  // "open sky" has to hold across roughly +/-90 world px or the controls contain
  // terrain — which this fixture has already caught once, and says so above.
  const landY = await page.evaluate(
    ([x, y0]) => {
      const core = window.__game.core
      let best = core.height
      for (const dx of [-90, -45, 0, 45, 90]) {
        const cx = Math.round(x + dx)
        for (let y = Math.round(y0); y < core.height; y++) {
          if (core.solidAt(cx, y)) {
            if (y < best) best = y
            break
          }
        }
      }
      return best
    },
    [seen.mirror.x, seen.mirror.y],
  )
  const drop = landY - seen.mirror.y
  // Frame a third of the way down, and ask for another third of a fall after
  // that. Both derived, so a map that drops a crate 250 px and one that drops it
  // 1200 px are photographed at the same point in the flight.
  const frameAt = seen.mirror.y + Math.max(40, Math.round(drop * 0.3))
  // How far the crate has to fall for the control frame: **enough to take the
  // canopy out of the rect, and no further.**
  //
  // Derived from the drawing, not from the flight. `itemSprites` puts the canopy
  // 34 px above the crate with a radius of 20, and the rect is 42 screen px tall
  // — 21 world px at zoom 2. 80 px clears all of it.
  //
  // It used to be a third of the fall, which on a long drop is 200 px and about
  // 0.4 s of wall clock. That window is not free: the scene keeps moving in it —
  // the lightmap is radial about the player (§A3) and the sky animates — and the
  // fixture's own noise control measured 13-24 in a rect with nothing in it, on
  // the same seed, run to run. At a floor of `max(45, drift * 3)` that is a gate
  // decided by which end of that range the run lands on. Halving the window
  // halves the noise; the canopy is just as gone.
  const fellBy = 80
  console.log(`    fall: y ${seen.mirror.y.toFixed(0)} -> clear to ${landY}, frame at ${frameAt}, then +${fellBy}`)
  if (landY - frameAt < fellBy + 60) {
    fail(
      `the crate has ${drop} px of clear air under it and only ${landY - frameAt} px below the ` +
        `framing point — not enough for the control frame (needs ${fellBy + 60})`,
    )
  }

  // --- the fall, sampled from what is drawn ------------------------------
  //
  // Sampled as fast as the page will answer, and with nothing else happening in
  // the loop. The first version walked the player between samples, which put
  // 550 ms between them and reduced a two-second fall to two data points — a
  // fall observed twice is barely observed.
  for (let i = 0; i < 200; i++) {
    const c = await crateNow()
    if (!c.mirror) break // taken already
    if (c.drawn) samples.push({ t: i, y: c.drawn.y, sy: c.mirror.y, g: c.drawn.grounded })
    sawChute = Math.max(sawChute, c.chutes)
    if (c.drawn?.grounded) break
    // The one moment worth photographing. Point the camera at the crate to do
    // it: the alternative is a screenshot of wherever the player happens to be,
    // which is what the first version produced — three runs of
    // `crate-falling.png` containing no crate at all.
    // Framed at a fixed ALTITUDE, not after a fixed number of samples. The poll
    // rate varies by tens of milliseconds and a falling crate covers a lot of
    // ground in that, so "the sixth sample" was a different height every run —
    // which moved the control patches around too, and on one run put terrain in
    // one of them. The crate passes through y=220 exactly once, every time.
    // y=130: open sky on this map. 220 is not — the screenshot from that run
    // shows the crate descending through a cave, with rock either side of it, and
    // the check correctly refused to call a canopy out of a background that was
    // half terrain. The altitude is a fixture choice about *this* seed, and the
    // "control patches differ" failure above is what tells the next person so.
    //
    // Holding the frame costs about a second, and the server does not stop: the
    // crate usually lands during it. So the observed fall below is the part
    // before this point — still hundreds of pixels, and still zero when the
    // drain is broken.
    if (!framedInFlight && c.mirror.y >= frameAt) {
      // Point the camera at the crate and photograph it. The alternative is a
      // screenshot of wherever the player happens to be, which is what the first
      // version produced: three runs of `crate-falling.png` containing no crate.
      //
      // The world point is remembered, because the control for "a falling crate
      // puts pixels here" is *this same rect, from this same camera point, once
      // the crate has gone*. Comparing against a patch of sky somewhere else
      // would be comparing two different places and calling the difference a
      // crate.
      // Aim, settle, *then* stop the world — in that order.
      //
      // Freezing first looks like it should be better: the crate stops where the
      // entry test found it instead of falling another ~190 px while the camera
      // is aimed. It is not, and the reason is worth writing down. `freeze` stops
      // the *client*; the server keeps simulating, so the crate's reported
      // position advances anyway — and with the client frozen the camera rig
      // stops lerping too, so `watch` never arrives. Measured: the crate ended up
      // at screen y=630 of 720, the canopy rect landed on empty sky 100 px above
      // it, and the pixel assertion read a delta of 1.8 against a floor of 45.
      //
      // So the settle is not overhead to be optimised away, it is what puts the
      // subject in the middle of the frame. The overshoot it costs is paid for by
      // choosing a seed with enough clear air under the crate (`CRATE_SEED`).
      //
      // Aimed slightly below the crate: it keeps falling while the frame is
      // captured, and a subject centred at the moment of the snap is low in the
      // frame by the time the shutter opens.
      flightPos = { x: c.mirror.x, y: c.mirror.y + 90 }
      await page.evaluate(([x, y]) => window.__game.watch(x, y), [flightPos.x, flightPos.y])
      await sleep(160)
      await page.evaluate(() => window.__game.freeze(true))
      // Read where the crate actually is on screen rather than assuming the
      // camera centred on it. It does not: the rig lerps, and the crate keeps
      // falling while it does. Assuming the centre put the patch 200 px above
      // the crate and measured a delta of 11.5 for a frame that, looked at, has
      // a parachute in the middle of it.
      const cur = await crateNow()
      // Positioned off the **drawn** sprite, not the mirror.
      //
      // The frozen frame shows where the client last rendered the crate; the
      // mirror is where the server says it is, and between them sit a snapshot
      // interval and the render interpolation. The rect is 26x42 on a canopy
      // about 80 px wide at this zoom, so tens of pixels of disagreement move it
      // off the subject — and it did: the same seed measured 51.0 on one run and
      // 39.7 on the next against a floor of 45. That is a gate that fails on a
      // coin flip, which gates nothing.
      const sp = cur.drawn ? await screenPos(cur.drawn) : cur.mirror ? await screenPos(cur.mirror) : null
      const _d = await dbg()
      console.log(
        `    framing: crate (${cur.mirror?.x?.toFixed(0)}, ${cur.mirror?.y?.toFixed(0)}) ` +
          `view (${_d.worldView?.x?.toFixed(0)}, ${_d.worldView?.y?.toFixed(0)}) zoom ${_d.zoom} ` +
          `-> ${sp ? `${sp.sx.toFixed(0)},${sp.sy.toFixed(0)}` : 'off screen'}`,
      )
      if (sp) {
        // Sized onto the subject, and onto the part of it nothing else occupies.
        //
        // Two earlier versions failed to discriminate, both found by deleting
        // every parachute draw call and re-running rather than by reading the
        // code. A 140x150 patch around the whole crate still passed at 46.7
        // against a floor of 35.4 — the crate sprite alone moved it. A 90 px
        // band above the crate still passed at 118 against 61 — the beacon's
        // beam runs up through it and is the brightest thing in the frame.
        //
        // Meanwhile `chutesDrawn` read 1 on every one of those runs, because it
        // is incremented inside the loop that draws: it reports intent, which is
        // exactly the §A15 shape T13.04 was about.
        //
        // The canopy's LEFT SHOULDER, not the whole area above the crate. The
        // first version took a 90 px band above the crate and passed with every
        // parachute draw call deleted (118 against a floor of 61) — because the
        // beacon's beam runs straight up through the middle of that band and is
        // the brightest thing in it. At zoom 2 the beam is about ±13 px wide at
        // canopy height and the canopy spans ±40, so a strip from -44 to -16
        // holds canopy and no beam.
        // Left of the beam (±13 px at this height) and above the crate's own
        // glow disc (radius up to 56 px), so what is left in it is canopy.
        canopyRect = { x: Math.round(sp.sx - 44), y: Math.round(sp.sy - 100), w: 26, h: 42 }
        canopy = await samplePatch(page, canopyRect)
        // The control, from the SAME FROZEN FRAME: the same band of sky 200 px
        // to either side, where there is no crate, no canopy and no beacon.
        //
        // The first control was this same rect re-framed after the crate had
        // landed — the same place, thirty seconds later. The sky animates, so
        // that measured the parachute plus half a minute of drift: the floor
        // came out at 6.5 on one run and 60.2 on the next, and a threshold built
        // on it failed a build for having a slow sky. Two patches from one frame
        // cannot drift relative to each other.
        //
        // The control is **the same rect, the same camera, half a second
        // later** — once the crate has fallen out of it.
        //
        // Three spatial controls were tried and all three were wrong, each for
        // its own reason, and each failure was reported honestly by this
        // fixture's own "the controls are not both plain sky" guard rather than
        // being mistaken for a canopy:
        //
        //   ±200 px hardcoded  — only sky if the crate happens to be falling
        //                        through open air; down a shaft both are rock
        //                        (differed by 186).
        //   ±N px, mask-probed — empty, but the lightmap is radial about the
        //                        PLAYER (§A3), so with them 184 px off to one
        //                        side the far patch is darker (differed by 112).
        //   equal radius       — equal light, but the two land a thousand pixels
        //                        apart in a vertically graded sky (236).
        //
        // Time removes all three: the camera is pinned to the same world point,
        // the player has not moved, the sun has not moved, and the only thing
        // that changed in that rect is that the parachute left it. The reason
        // the original version compared across time and failed was that it
        // compared across *thirty seconds*, after the crate had landed — long
        // enough for the sky to animate. Half a second is not.
        canopyRect = { x: Math.round(sp.sx - 44), y: Math.round(sp.sy - 100), w: 26, h: 42 }
        canopy = await samplePatch(page, canopyRect)
        // A second rect, sampled in both frames, as the noise term: whatever it
        // moves by is what this scene does on its own in that half second.
        //
        // **Placed by content, not at a fixed offset.** A hardcoded -120 px is
        // only "a rect with nothing in it" if there happens to be nothing there,
        // and on a different map there is: this fixture's own guard reported it
        // drifting 21-23 against a ceiling of 20 and correctly refused to
        // attribute anything. Search outward for the nearest offset whose world
        // pixels are all air, and say so if there is none.
        const quietRect = await page.evaluate(
          (rect) => {
            const g = window.__game.debug()
            const v = g.worldView
            const cv = document.querySelector('canvas')
            const r = cv.getBoundingClientRect()
            const core = window.__game.core
            const toWorld = (sx, sy) => ({
              x: v.x + (sx / r.width) * v.w,
              y: v.y + (sy / r.height) * v.h,
            })
            const clear = (x0) => {
              for (let dx = -2; dx <= rect.w + 2; dx += 4) {
                for (let dy = -2; dy <= rect.h + 2; dy += 6) {
                  const p = toWorld(x0 + dx, rect.y + dy)
                  if (core.solidAt(Math.round(p.x), Math.round(p.y))) return false
                }
              }
              return true
            }
            for (const off of [-120, 120, -170, 170, -220, 220, -280, 280]) {
              const x0 = rect.x + off
              if (x0 < 4 || x0 + rect.w > r.width - 4) continue
              if (clear(x0)) return { ...rect, x: Math.round(x0) }
            }
            return null
          },
          canopyRect,
        )
        if (!quietRect) {
          fail(
            'no rect of open air beside the canopy to use as the noise control — ' +
              'the crate is falling too close to terrain on this map',
          )
        }
        const quietBefore = quietRect ? await samplePatch(page, quietRect) : null
        await shot('crate-falling')

        // Let the crate fall clear of the rect, then re-pin the SAME point.
        await page.evaluate(() => window.__game.freeze(false))
        let cleared = false
        for (let w = 0; w < 200 && !cleared; w++) {
          const c2 = await crateNow()
          if (!c2.mirror) break // taken or landed already
          cleared = c2.mirror.y > cur.mirror.y + fellBy
          // No sleep: the evaluate round trip is already the poll interval, and
          // every millisecond spent here is scene motion the noise control has to
          // absorb.
        }
        if (!cleared) {
          fail(
            `the crate never fell a further ${fellBy} px while framed, so there is no ` +
              '"after" frame to compare the canopy against',
          )
        } else {
          // Freeze the instant the crate has cleared, and do not settle the camera
          // again: it is still pinned to `flightPos` from the first frame, so
          // there is nothing to settle. The 160 ms that used to sit here is 160 ms
          // of extra scene motion in a window whose whole purpose is to hold the
          // scene still — and the noise control is measured over exactly this
          // window. Under full-suite load it read 23 against a ceiling of 20 while
          // reading 12.8 standalone, which is the same run failing or passing on
          // how busy the box is.
          await page.evaluate(() => window.__game.freeze(true))
          await page.evaluate(([x, y]) => window.__game.watch(x, y), [flightPos.x, flightPos.y])
          skyL = await samplePatch(page, canopyRect)
          skyR = quietRect ? await samplePatch(page, quietRect) : null
          // `skyL` is the canopy's own rect with the canopy gone; `skyR` is the
          // quiet rect, whose change between the two frames is the noise floor.
          // Named for the shape the assertion below already had.
          quietDriftValue =
            quietBefore && skyR
              ? Math.hypot(
                  quietBefore.r - skyR.r,
                  quietBefore.g - skyR.g,
                  quietBefore.b - skyR.b,
                )
              : 0
          const drift = quietDriftValue
          console.log(
            `    control: the same rect after the crate fell ${fellBy} px; ` +
              `a quiet rect beside it drifted ${drift.toFixed(1)} in the same window`,
          )
          framedInFlight = true
        }
      }
      await shot('crate-falling')
      await page.evaluate(() => window.__game.freeze(false))
      await page.evaluate(() => window.__game.watch(null))
    }
  }
  if (!framedInFlight) {
    console.log('  note: the crate fell off camera — no in-flight screenshot to look at')
  }

  const moving = samples.filter((s) => !s.g)
  if (moving.length < 2) {
    fail(
      `only ${moving.length} samples of the crate in flight — the fall was not observed, so ` +
        'nothing here tested that it is drawn falling',
    )
  } else {
    // Drawn y increases (screen coordinates) and then stops. Sampled from the
    // sprites, not from the mirror: §C2 asks what was rendered.
    const first = moving[0]
    const last = moving[moving.length - 1]
    if (last.y > first.y + 20) {
      ok(`the drawn crate fell ${(last.y - first.y).toFixed(0)} px over ${moving.length} samples`)
    } else {
      fail(
        `the drawn crate moved ${(last.y - first.y).toFixed(0)} px while falling — this is the ` +
          'bug: the client draws it where it spawned and never follows it',
      )
    }
    // Monotone down, allowing for the sub-pixel settle the sim makes on landing.
    const wrongWay = moving.filter((s, i) => i > 0 && s.y < moving[i - 1].y - 1)
    if (wrongWay.length) fail(`the drawn crate moved upward ${wrongWay.length} times`)

    // Logged, not asserted: `chutesDrawn` is incremented by the loop that draws,
    // so it reports what the code meant to do. Deleting every parachute draw
    // call leaves it reading 1. The assertion that this is visible is in pixels,
    // below.
    console.log(`    (chutesDrawn reported ${sawChute} — intent, not evidence)`)
  }

  // --- at rest: the two ends must agree ----------------------------------
  let rest = null
  for (let i = 0; i < 60 && !rest; i++) {
    const c = await crateNow()
    if (!c.mirror) break
    if (c.drawn?.grounded) {
      // Let a few frames run before reading the resting state. `drawn` is the
      // sprite position and the sprite moves in `update`, so sampling on the
      // frame the landing arrives reads the position from just before it — 21 px
      // out, and a parachute that is one frame from being cleared. Both are
      // real reads of a transient, and neither is what "at rest" means.
      await sleep(500)
      rest = await crateNow()
      if (!rest.mirror) rest = null
    } else await sleep(250)
  }
  if (rest) {
    const dx = Math.abs(rest.drawn.x - rest.mirror.x)
    const dy = Math.abs(rest.drawn.y - rest.mirror.y)
    // 4 px: the sprite bobs by BOB_AMPLITUDE (3) once it is grounded.
    if (dx < 4 && dy < 4) {
      ok(`drawn at (${rest.drawn.x.toFixed(0)}, ${rest.drawn.y.toFixed(0)}), server agrees`)
    } else {
      fail(
        `the crate is drawn at (${rest.drawn.x.toFixed(0)}, ${rest.drawn.y.toFixed(0)}) and the ` +
          `server says (${rest.mirror.x.toFixed(0)}, ${rest.mirror.y.toFixed(0)}) — ${dy.toFixed(0)} px apart`,
      )
    }
    // "Not in the sky" asserted against the mask rather than against a y
    // threshold. The first version used `y > 200` and a crate that legitimately
    // landed on a high ledge at y=134 failed it — a threshold read off one run,
    // which is the same mistake as tuning a pixel delta to one map.
    //
    // Probed the way the simulation probes (`WorldItems::supported`): the row
    // one pixel below the AABB's bottom edge, across the full footprint, `any`.
    // A single probe at the centre is a different question and answers it
    // differently on a crate resting on the lip of a crater.
    const supported = await page.evaluate(
      ([x, y]) => {
        const row = Math.round(y + 12)
        const x0 = Math.round(x - 12)
        const x1 = Math.round(x + 12) - 1
        for (let px = x0; px <= x1; px++) {
          if (window.__game.core.solidAt(px, row)) return true
        }
        return false
      },
      [rest.mirror.x, rest.mirror.y],
    )
    if (supported) ok(`it is resting on solid ground at y=${rest.mirror.y.toFixed(0)}`)
    else fail(`it "landed" at y=${rest.mirror.y.toFixed(0)} with nothing under it`)
    if (rest.chutes === 0) ok('the parachute is gone once it has landed')
    else fail('a landed crate is still drawing a parachute')

    // --- the pixels ------------------------------------------------------
    //
    // Everything above this point is counters and coordinates, and T13.04 is the
    // reason that is not enough: the toxic rain reported a real 36.6 colour
    // delta while the droplets were invisible behind a vignette. A count of
    // parachutes drawn says drawing happened, not that anything became visible —
    // and `chutesDrawn` did read 1 on a build with every parachute draw call
    // deleted.
    if (canopy && skyL && skyR) {
      const d = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
      // `skyL` is the canopy's own rect once the crate has fallen out of it;
      // `skyR` is the quiet rect beside it in that same later frame, and
      // `quietDrift` is how much that quiet rect moved between the two frames —
      // i.e. everything about the scene that is not the parachute.
      const canopyDelta = d(canopy, skyL)
      const quietDrift = quietDriftValue
      // 45 is set by falsification, not by taste. With the parachute drawn this
      // strip moves 80-91; with every parachute draw call deleted it moves
      // 16-27, which is the beacon's spill and the crate's glow reaching the
      // bottom of the strip. Anything between those two bands separates them;
      // 45 sits in the middle of the gap. The drift term is the second floor,
      // for the case where the scene itself is doing something in that window.
      const floor = Math.max(45, quietDrift * 3)
      if (quietDrift > 20) {
        fail(
          `a rect with nothing in it moved by ${quietDrift.toFixed(1)} between the two ` +
            'frames — something other than the parachute changed, so this fixture cannot ' +
            'attribute the difference to a canopy',
        )
      } else if (canopyDelta > floor) {
        ok(
          `the canopy's own rect moved ${canopyDelta.toFixed(1)} when the crate fell out of ` +
            `it (floor ${floor.toFixed(1)}, quiet rect drifted ${quietDrift.toFixed(1)})`,
        )
      } else {
        fail(
          `the canopy's rect moved only ${canopyDelta.toFixed(1)} when the parachute left ` +
            `it, against a floor of ${floor.toFixed(1)} — nothing is being drawn there`,
        )
      }
    } else {
      fail('the crate was never framed in flight — the pixel assertion did not run')
    }
  } else {
    // Not a note. If this branch is taken, four assertions above did not run,
    // and a check that quietly skips its assertions reports the same "ok" as one
    // that passed them. With a fixed seed the crate lands every time, so getting
    // here means something changed.
    fail('the crate was never observed at rest — the landing assertions did not run')
  }

  // --- the pickup, at both ends ------------------------------------------
  //
  // The end that matters for this task is not "the server removed it" — the
  // server always did. It is that the client stops drawing it, because a client
  // that never learned where the crate was would happily keep drawing the ghost.
  //
  // Our own client does the walking. Bots were the first plan and are not
  // reliable for this: `choose_goal` sends them at the *nearest* item, and with
  // an item spawning every ITEM_SPAWN_INTERVAL the crate is rarely that. A gate
  // that depends on a bot happening to want the crate is a coin flip.
  let gone = null
  let held = null
  let closest = Infinity
  let framedAtRest = false
  let last = null
  let stuckFor = 0
  let jetting = false
  /** Jetpack duty cycle: polls spent in this burst, and polls left resting. */
  let jetPolls = 0
  let jetRest = 0
  let lastGap = Infinity
  /** Last lane probe result, refreshed as we move. */
  let lane = null
  const pickupsBefore = (await dbg()).observed?.itemPickups ?? 0

  /**
   * Is the straight line from here to the crate blocked, and how high is the
   * thing blocking it?
   *
   * Asked of the client's own mask, the same `core.solidAt` `night-combat` and
   * `terrain-render` now probe with. Pass 6b stamps scenery into the terrain and
   * the approach loop is explicitly not a pathfinder — it holds a direction and
   * jets — so it walks into a rock and stays there. Measured on the old pinned
   * seed: pinned at (1641, 499) for 354 consecutive polls, jetpack firing,
   * 199 px short of a crate at (1547, 324).
   */
  const laneTo = (from, to) =>
    page.evaluate(
      ([a, b]) => {
        const core = window.__game.core
        const dx = b.x - a.x
        const dy = b.y - a.y
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4))
        let firstHit = null
        let topOfBlock = null
        for (let i = 1; i <= steps; i++) {
          const x = Math.round(a.x + (dx * i) / steps)
          const y = Math.round(a.y + (dy * i) / steps)
          if (!core.solidAt(x, y)) continue
          if (!firstHit) firstHit = { x, y }
          // How far up we would have to be to clear it at this column.
          let up = y
          while (up > 0 && core.solidAt(x, up)) up -= 2
          if (topOfBlock === null || up < topOfBlock) topOfBlock = up
        }
        return { blocked: !!firstHit, firstHit, topOfBlock }
      },
      [from, to],
    )

  const deadline = Date.now() + 70_000
  for (let i = 0; Date.now() < deadline && !gone; i++) {
    const c = await crateNow()
    const stillThere = (c.d.mirrorItems ?? []).find((it) => it.id === id)
    if (!stillThere) {
      // "Stops being drawn" is a **convergence**, not a same-frame read. The
      // mirror drops the item the instant the `item_pickup` event lands, and the
      // sprite goes on the next `update()` — so sampling both from one
      // `debug()` call reports a lingering sprite for a client that is behaving
      // correctly, one frame later. What the bug being guarded against looks
      // like is a sprite that NEVER goes, so this waits a bounded moment and
      // asserts on that.
      let drawnAfter = true
      for (let w = 0; w < 30 && drawnAfter; w++) {
        await sleep(100)
        drawnAfter = ((await dbg()).drawnItems ?? []).some((it) => it.id === id)
      }
      gone = {
        stillDrawn: drawnAfter,
        // How far our own player was from it on the last frame it existed. The
        // pickup is only ours if we were inside PICKUP_RADIUS when it went.
        tookItFrom: lastGap,
        // **Picked up, not merely absent.** The loop breaks on "no longer in
        // `mirrorItems`", and an item that timed out on the ground satisfies
        // that exactly as well as one somebody took — so without this the
        // check reports a successful pickup for a crate nobody ever reached.
        // With bots in the room it was worse still: a bot took it 190 px away
        // and the failure message said "our client flew at the crate".
        pickups: (c.d.observed?.itemPickups ?? 0) - pickupsBefore,
      }
      break
    }
    const me = c.d.player
    if (me) {
      const dx = stillThere.x - me.x
      lastGap = Math.hypot(dx, stillThere.y - me.y)
      closest = Math.min(closest, lastGap)
      // Hold the key down rather than tapping it: a 400 ms tap with a gap after
      // it walks at about half speed, and the round is not long enough for that.
      // Always toward the crate.
      //
      // A sidestep-when-blocked rule was tried and is why this comment exists: it
      // flips direction on a stall, and with the crate *below* and to the right
      // every flip is away from it. Measured, the walker oscillated between
      // x=1153 and x=1440 for 45 s of a 70 s budget and finished 432 px away
      // having twice been within 260. Going the wrong way on purpose needs a
      // reason better than "we stopped moving".
      // Refreshed as we move, for the failure message below. It is **not** used
      // to steer: a "climb above the obstruction" policy was tried and reverted.
      // It releases the movement key while climbing, and on seed 555 the player
      // drifted from x=1641 to x=1856 — away from a crate at x=1547 — and ended
      // 343 px short instead of 199. Going over an obstruction reliably is
      // pathfinding, and this loop says plainly that it is not a pathfinder.
      if (i % 8 === 0) {
        lane = await laneTo({ x: me.x, y: me.y }, { x: stillThere.x, y: stillThere.y })
      }
      const want = dx > 0 ? 'd' : 'a'
      if (held !== want) {
        if (held) await page.keyboard.up(held)
        await page.keyboard.down(want)
        held = want
      }
      // Terrain is not flat, and "hold left" walks into the first ledge and
      // stays there for the rest of the round. Measured on seed 4242 after the
      // room-on-demand change: the crate on a shelf at (1144, 627), the player
      // in the pit below it at (1194, 922), closest approach 91 px in 70 s
      // against a PICKUP_RADIUS of 20 — and every hop landing back in the pit.
      //
      // So fly. Hold jump while the crate is above us: past JETPACK_HOLD_DELAY
      // (0.18 s) that is the jetpack, and JETPACK_MAX_SPEED (260) for
      // JETPACK_MAX_FUEL (5 s) is more climb than this map is tall. Released
      // once level with the crate, so the fuel refills for the next lift rather
      // than being spent overshooting into the sky.
      const above = me.y - stillThere.y // >0: the crate is higher than we are
      // Fly when the crate is above us, or when a wall has stopped us — and fly
      // in **bursts**, because the tank does not refill while the key is down.
      //
      // Both halves were paid for. `above > 24` alone only lifts you toward a
      // crate that is higher than you are, so a crate 1265 px away at the bottom
      // of a canyon never triggered it: the walker hit the first cliff and
      // covered 500 px in 70 s. Adding "or stuck" then held Space forever, which
      // drains `JETPACK_MAX_FUEL` (5 s) and then holds an empty tank down through
      // `JETPACK_REFILL_DELAY` for the rest of the round — measured 6 s pinned at
      // x=1440 with the stall counter climbing to 37 and the body not moving.
      //
      // 20 polls of burst is ~3.2 s at APPROACH_POLL_MS, inside the tank; 16 of
      // rest is ~2.6 s, past the refill delay.
      let wantJet = false
      if (jetRest > 0) {
        jetRest--
      } else if (above > 24 || stuckFor > 3) {
        if (jetPolls < 20) {
          wantJet = true
          jetPolls++
        } else {
          jetPolls = 0
          jetRest = 16
        }
      } else {
        jetPolls = 0
      }
      if (wantJet !== jetting) {
        if (wantJet) await page.keyboard.down('Space')
        else await page.keyboard.up('Space')
        jetting = wantJet
      }
      // Being stuck at ground level is still possible — out of fuel under a
      // ledge — so keep the hop as the fallback for a body that is not moving.
      const moved = last === null || Math.abs(me.x - last) > 1.5
      last = me.x
      if (moved) stuckFor = 0
      else stuckFor++
      // The hop stays as the zero-fuel fallback: `wantJet` above holds Space while
      // stuck, and when the tank is empty that does nothing at all.
      if (!jetting && stuckFor > 0) await page.keyboard.press('Space')
      if (i % 12 === 0) {
        console.log(
          `    approach: me (${me.x.toFixed(0)}, ${me.y.toFixed(0)}) ` +
            `grounded=${me.grounded} jet=${jetting} stuck=${stuckFor} key=${want} ` +
            `crate (${stillThere.x.toFixed(0)}, ${stillThere.y.toFixed(0)})`,
        )
      }
      // Close enough that the crate and its beacon are in frame: this is the
      // picture a human should look at to judge whether any of this reads.
      if (!framedAtRest && Math.abs(dx) < 200 && (await screenPos(stillThere))) {
        await shot('crate-landed')
        framedAtRest = true
      }
    }
    await sleep(APPROACH_POLL_MS)
  }
  if (held) await page.keyboard.up(held)
  if (jetting) await page.keyboard.up('Space')
  if (!gone) {
    // Say **why**, not just how close. A closest-approach number alone reads as
    // "the pickup is broken" when the truth is usually "there was a rock in the
    // way" — the lane probe knows which, so it is reported rather than left for
    // the next person to rediscover with a 70 s run.
    const why = lane?.blocked
      ? `terrain blocked the lane at (${lane.firstHit?.x}, ${lane.firstHit?.y}), clearable ` +
        `from y=${lane.topOfBlock}`
      : 'the lane was clear, so this is the approach or the pickup, not the map'
    fail(
      `our client flew at the crate for 70 s and never picked it up — closest ` +
        `approach ${closest.toFixed(0)} px, PICKUP_RADIUS is 20; ${why}`,
    )
  } else if (!(gone.pickups > 0)) {
    fail(
      `the crate stopped existing without anybody picking it up (itemPickups did not ` +
        `move) — it expired on the ground, and the pickup was never exercised`,
    )
  } else if (gone.stillDrawn) {
    fail('the crate was picked up and the client is still drawing it')
  } else {
    // Pinned to the sim's own constant, not to the 20 this comment used to say
    // in prose: a check carrying its own copy of a tunable stays green against a
    // drifted implementation (§A19).
    const k = await page.evaluate(() => window.__game.constants())
    // The tolerance is **derived**, not picked. `tookItFrom` is the last
    // distance sampled before the crate vanished, and the approach loop samples
    // every APPROACH_POLL_MS — so between that sample and the pickup the player
    // could have closed by a whole poll interval at full speed. A bound of
    // `2 * PICKUP_RADIUS` failed at 44 px for a pickup that was certainly ours
    // (no bots in the room, and `itemPickups` moved), which is a threshold read
    // off one run rather than off the fixture.
    const radius = k.PICKUP_RADIUS
    const reachable = radius + k.JETPACK_MAX_SPEED * (APPROACH_POLL_MS / 1000)
    if (!(gone.tookItFrom <= reachable)) {
      fail(
        `the crate vanished while our player was ${gone.tookItFrom.toFixed(0)} px away ` +
          `(PICKUP_RADIUS ${radius}, reachable in one ${APPROACH_POLL_MS} ms poll is ` +
          `${reachable.toFixed(0)}) — somebody else took it, so this proved nothing ` +
          'about walking to a crate',
      )
    } else {
      ok(
        `our client took it from ${gone.tookItFrom.toFixed(0)} px (radius ${radius}, ` +
          `bound ${reachable.toFixed(0)}) ` +
          'and it stopped being drawn — both ends',
      )
    }
  }
  await shot('crate-taken')
}

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)

await stack.close()

if (failures.length) {
  console.error(`\ncrates: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncrates: ok')
process.exit(0)
