#!/usr/bin/env node
/**
 * `fire-visible` — §F10.3: **you can see where the fire is.**
 *
 * The picture is the whole point of §F10. Fire used to be two things and neither
 * was a fire: an arc that was *checked* each tick, and static discs of "burning
 * ground". A molotov now bursts into `MOLOTOV_FLAMES` objects that fly, fall,
 * settle and burn, and this check photographs the result in a real game.
 *
 * ## Why a brightness number would prove nothing
 *
 * **A single disc is bright too.** Mean luminance, a delta against a control
 * frame, a lit-pixel count — every one of them passes unchanged for the disc
 * §F10.2 deleted, which is exactly the design being replaced. So the assertions
 * below are about *where* the light is, not how much of it there is.
 *
 * ## The task asked for ≥ half `MOLOTOV_FLAMES` connected clusters. That is
 * ## arithmetically impossible, and it is a task-file defect, not a shortfall.
 *
 * Measured, on this seed, over two throws: the 24 flames settle across **92–108
 * world px** of ground. Twelve connected components would need twelve gaps in
 * that span, and one flame is `FLAME_RADIUS` 10 px of damage drawn about as
 * wide — so the crowd averages ~4 px between neighbours that are each ~20 px
 * across. They touch, whatever the renderer does, and a connected-component
 * count collapses to 2–4. **No drawing can satisfy a floor of 12**, and lowering
 * the floor to whatever came out is the number-that-made-it-pass trap. Both
 * numbers are reported below and neither is asserted on.
 *
 * What replaced it is stronger, because it is counted at **both ends** (§A39):
 *
 *  1. **Every distinct place the simulation says is on fire is bright**, sampled
 *     at that flame's own screen position. A renderer that drew one disc at the
 *     impact lights the clump under it and leaves the other clump dark; a
 *     renderer that drew nothing fails outright. This is "many separate bright
 *     sources" counted properly — the sources are enumerated by the server and
 *     each one is checked, rather than guessed at from blob topology.
 *  2. **The lit region is as wide as the flame field**, in world px, either side
 *     bounded. A disc is narrower than the crowd; a smear is wider. The bound is
 *     the simulation's own spread, so there is no invented number in it.
 *  3. **A control patch away from the impact is unchanged**, and a **control
 *     frame** before the throw scores nothing — without both, "there are bright
 *     pixels" passes for a map with a bright sky in it (§A16).
 *
 * Plus `hazardsDrawn === 0`: the burning-ground disc is gone at the source as
 * well as on the screen.
 *
 * **Falsified at the live binding site**, by making `ordnance.ts` draw the design
 * §F10 replaced — one 30 px disc at the oldest flame and nothing for the other
 * 23. Red, and for the right reasons: *"3 of 4 burning places are dark on screen
 * — the simulation is on fire there and the picture is not"*, and *"the lit
 * region is 11 world px wide against a flame field of 108"*. A brightness check
 * would have called that frame a pass.
 *
 * ## Four false readings this check has already given, all fixed
 *
 * - The sampled rect ran to y 680 and took the quick bar with it. Throwing
 *   changes a tile's count and its highlight, so it reported 5–6 hot clusters
 *   with `MOLOTOV_FLAMES` set to 1 — it was counting the inventory.
 * - The base frames were captured before `mouse.move`. Aiming swings the held
 *   weapon and moves the crosshair, both warm, both in frame: it was counting
 *   the player's arm. Everything that moves except the fire moves first now.
 * - Hot pixels were once found by an absolute threshold (`r > 170 && r - b >
 *   70`), and the *unlit* control frame scored 11 clusters: this map's terrain
 *   is brown, and brown is warm. Every reading here is a **difference** against
 *   a base frame.
 * - It **under**-counted the fire by a factor of two, and that was the renderer:
 *   flames were drawn additively, ten of them overlapped, and the centre summed
 *   past white — where `r - b` is 0, so the hottest part of the fire failed the
 *   "is this warm" test and only the rims scored. Painting them instead
 *   (`ordnance.ts`) took the hot-pixel count from 1551 to 2952 on the same
 *   throw, and made the picture look like fire rather than like steam.
 */
import { join } from 'node:path'
import {
  startStack,
  enterBattle,
  tally,
  sleep,
  standStill,
  selectWeapon,
  shotsDir,
} from './harness.mjs'

const PORT = 3143
const { fail, ok, failures } = tally('fire-visible')

/**
 * The frame region sampled. Wide, because the spread is the subject — and it
 * stops at y 580, above the quick bar. The player's own sprite sits above y 300.
 */
const FIELD = { x: 240, y: 300, w: 820, h: 280 }
/** Away from the impact, in the same frame: it must not light up. */
const CONTROL = { x: 8, y: 40, w: 160, h: 120 }
/**
 * A pixel is "lit by fire" when it has **gained** this much red over the same
 * pixel in the base frame *and* ended up warm. Both terms are needed: the sky
 * animates (§A4) and drifts the whole frame a little, and something merely
 * getting brighter is not a flame.
 */
const GAIN = 45
const WARM_R = 150
const WARM_RB = 60
/** Half-width of the patch sampled at a flame's own screen position, px. */
const PATCH = 5

/** World -> screen, the §A35-correct way: `worldView` and zoom, never scrollX. */
const screenPos = (d, w) => ({ sx: (w.x - d.worldView.x) * d.zoom, sy: (w.y - d.worldView.y) * d.zoom })

/** Screenshot a region as base64, for measuring against. */
async function grab(page, rect) {
  return (
    await page.screenshot({ clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } })
  ).toString('base64')
}

/**
 * Measure a region against a base frame of the same region.
 *
 * Returns the hot-pixel count, the connected-cluster count, the lit bounding box
 * in region pixels, and — for each requested probe point — the peak gain in a
 * `PATCH`-sized patch around it. One screenshot, one decode, every number.
 *
 * Clusters are labelled with a flood fill on a 4 px grid. At full resolution one
 * flame's anti-aliased edge is a hundred pixels and the count becomes a measure
 * of the blur radius. They are reported, not asserted on: see the header.
 */
async function measure(page, rect, baseB64, probes) {
  const b64 = await grab(page, rect)
  return page.evaluate(
    async ({ src, base, cell, probes: pts, gain, warmR, warmRB, patch }) => {
      const load = async (b) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return { d: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height }
      }
      const a = await load(src)
      const b = await load(base)
      const gw = Math.ceil(a.w / cell)
      const gh = Math.ceil(a.h / cell)
      const hot = new Uint8Array(gw * gh)
      const lit = new Uint8Array(a.w * a.h)
      let hotPx = 0
      let minX = a.w
      let maxX = -1
      for (let y = 0; y < a.h; y++) {
        for (let x = 0; x < a.w; x++) {
          const i = (y * a.w + x) * 4
          const dr = a.d[i] - b.d[i]
          const warm = a.d[i] > warmR && a.d[i] - a.d[i + 2] > warmRB
          if (dr > gain && warm) {
            hot[Math.floor(y / cell) * gw + Math.floor(x / cell)] = 1
            lit[y * a.w + x] = 1
            hotPx++
            if (x < minX) minX = x
            if (x > maxX) maxX = x
          }
        }
      }
      // Flood fill, 4-connected, iterative so a large blob cannot blow the stack.
      const seen = new Uint8Array(gw * gh)
      let count = 0
      const stack = []
      for (let c = 0; c < gw * gh; c++) {
        if (!hot[c] || seen[c]) continue
        count++
        stack.length = 0
        stack.push(c)
        seen[c] = 1
        while (stack.length) {
          const k = stack.pop()
          const kx = k % gw
          const ky = (k / gw) | 0
          const nb = [
            kx > 0 ? k - 1 : -1,
            kx < gw - 1 ? k + 1 : -1,
            ky > 0 ? k - gw : -1,
            ky < gh - 1 ? k + gw : -1,
          ]
          for (const n of nb) {
            if (n >= 0 && hot[n] && !seen[n]) {
              seen[n] = 1
              stack.push(n)
            }
          }
        }
      }
      // Each probe: is there a lit pixel within `patch` of it? A patch rather
      // than the single pixel, because a flame's centre is a sub-pixel world
      // position and the camera does not land it on an integer.
      const at = (pt) => {
        let n = 0
        for (let y = Math.max(0, pt.y - patch); y <= Math.min(a.h - 1, pt.y + patch); y++) {
          for (let x = Math.max(0, pt.x - patch); x <= Math.min(a.w - 1, pt.x + patch); x++) {
            if (lit[y * a.w + x]) n++
          }
        }
        return n
      }
      return {
        count,
        hotPx,
        spanPx: maxX < 0 ? 0 : maxX - minX + 1,
        probes: (pts ?? []).map((p) => ({ ...p, litPx: at(p) })),
      }
    },
    { src: b64, base: baseB64, cell: 4, probes, gain: GAIN, warmR: WARM_R, warmRB: WARM_RB, patch: PATCH },
  )
}

/** Median frame time over `seconds`, measured on rAF deltas as `perf` does. */
async function frameMs(page, seconds) {
  return page.evaluate(async (s) => {
    const frames = []
    let last = performance.now()
    const t0 = last
    await new Promise((done) => {
      const tick = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        if (now - t0 < s * 1000) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    frames.sort((x, y) => x - y)
    return frames[Math.floor(frames.length * 0.5)] ?? 0
  }, seconds)
}

const stack = await startStack({
  port: PORT,
  label: 'fire-visible',
  env: {
    FIXED_SEED: '4242',
    ROUND_SECONDS: '180',
    // No bots, and no weather. A meteor or a lava vent in frame is another warm
    // source, and this check measures warm sources — the same exclusion `crates`
    // makes for the same reason (T19.10's `WEATHER`).
    BOT_COUNT: '0',
    WEATHER: 'off',
    DEV_LOADOUT: '1',
    DEV_START_HEALTH: '150',
  },
})

try {
  const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
  await enterBattle(page, { waitPlaying: true, label: 'fire-visible' })
  const k = await page.evaluate(() => window.__game.constants())

  await standStill(page)
  await sleep(600)

  // **Select and aim first, and only then take the base frames** — see the
  // header. Thrown up and to the right: `ordnance` records that a molotov aimed
  // below the horizontal lands at the thrower's own feet, and a player standing
  // in 24 flames dies.
  await selectWeapon(page, 'molotov')
  await standStill(page)
  await page.mouse.move(1060, 200)
  await sleep(400)

  const baseField = await grab(page, FIELD)
  const baseControl = await grab(page, CONTROL)
  await shot('fire-before')

  // The noise floor, and it is a real control: another frame with nothing lit.
  // The sky animates (§A4) and the day/night curve moves, so this is not zero by
  // construction — and if it were large, every number below would be noise.
  await sleep(500)
  const idle = await measure(page, FIELD, baseField, [])
  console.log(`  with nothing lit: ${idle.count} cluster(s), ${idle.hotPx} px`)
  if (idle.count > 1) {
    fail(
      `${idle.count} cluster(s) appeared with nothing lit at all — the frame is ` +
        'different everywhere, so every reading below proves nothing',
    )
  } else {
    ok(`control: ${idle.count} cluster(s) appear with no fire`)
  }

  const lit0 = (await dbg()).flamesSpawned ?? 0
  await page.evaluate('window.__game.fire()')

  // Wait on the counter rather than a clock — the bottle has to fly before it
  // breaks — and then for the crowd to stop moving, on the positions themselves.
  // A flame that is still in the air is not yet where the fire will be.
  let live = 0
  for (let i = 0; i < 60; i++) {
    await sleep(200)
    const d = await dbg()
    live = (d.flamesSpawned ?? 0) - lit0
    if (live >= k.MOLOTOV_FLAMES) break
  }
  if (live < k.MOLOTOV_FLAMES) {
    fail(`the molotov lit ${live} flame(s), expected MOLOTOV_FLAMES (${k.MOLOTOV_FLAMES})`)
  } else {
    ok(`the server lit ${live} flames`)
  }
  const key = (ps) => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  let prev = ''
  for (let i = 0; i < 25; i++) {
    await sleep(200)
    const now = key((await dbg()).mirrorProjectiles ?? [])
    if (now && now === prev) break
    prev = now
  }

  // **Stop the scene before photographing it.** `freeze` pauses `update`, not
  // rendering, so two `requestAnimationFrame`s afterwards is one full render of
  // the stopped scene — after which the pixels and the positions describe the
  // same instant. Without this, under suite load Phaser's update outpaces its
  // render and a patch aimed from a position describes a flame the screenshot
  // has not drawn (measured on `birds`, 15.5 px standalone vs 0.0 in the suite).
  await page.evaluate(() => window.__game.freeze(true))
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  const d = await dbg()
  const flames = d.mirrorProjectiles ?? []
  if (!d.worldView || typeof d.zoom !== 'number') {
    fail('debug() reports no worldView/zoom — every position below would be undefined (§B15)')
  }

  // Distinct places that are on fire: flames within `FLAME_RADIUS` of one another
  // are one source on the screen and cannot be told apart by any renderer.
  const spots = []
  for (const f of flames) {
    if (!spots.some((s) => Math.hypot(s.x - f.x, s.y - f.y) < k.FLAME_RADIUS)) spots.push(f)
  }
  const xs = flames.map((f) => f.x)
  const fieldSpan = xs.length ? Math.max(...xs) - Math.min(...xs) : 0
  console.log(
    `  ${flames.length} flame(s) resting in ${spots.length} distinct spot(s), ` +
      `spread ${fieldSpan.toFixed(0)} world px`,
  )

  // A control on the *input*: if the crowd never scattered, everything below is
  // a statement about one fireball and §F10.3 is not being tested at all.
  if (spots.length < 2 || fieldSpan < k.FLAME_RADIUS * 4) {
    fail(
      `the simulation put ${flames.length} flames into ${spots.length} spot(s) across ` +
        `${fieldSpan.toFixed(0)} px — the crowd did not scatter, so the picture below ` +
        'cannot show a spreading fire',
    )
  } else {
    ok(`the crowd scattered: ${spots.length} distinct spots over ${fieldSpan.toFixed(0)} px`)
  }

  const probes = spots.map((s) => {
    const { sx, sy } = screenPos(d, s)
    return { x: Math.round(sx - FIELD.x), y: Math.round(sy - FIELD.y) }
  })
  const inFrame = probes.filter((p) => p.x >= 0 && p.x < FIELD.w && p.y >= 0 && p.y < FIELD.h)
  const after = await measure(page, FIELD, baseField, inFrame)
  const ctrlAfter = await measure(page, CONTROL, baseControl, [])
  await shot('fire-after')
  // The crop as well as the frame. A full 1280x720 shot of a fire 250 px wide is
  // a picture nobody can judge, and every number above is about this rectangle.
  await page.screenshot({
    path: join(shotsDir, 'fire-crowd.png'),
    clip: { x: FIELD.x, y: FIELD.y, width: FIELD.w, height: FIELD.h },
  })
  console.log(
    `  after: ${after.count} cluster(s), ${after.hotPx} hot px, lit ${after.spanPx} screen px, ` +
      `${inFrame.length}/${spots.length} spots in frame`,
  )

  // 1. Every distinct burning place is bright. This is the assertion: a disc at
  //    the impact lights the clump under it and nothing else.
  const dark = after.probes.filter((p) => p.litPx === 0)
  if (inFrame.length < 2) {
    fail(`only ${inFrame.length} burning spot(s) are on camera — nothing to compare`)
  } else if (dark.length > 0) {
    fail(
      `${dark.length} of ${inFrame.length} burning places are dark on screen ` +
        `(${dark.map((p) => `${p.x},${p.y}`).join(' ')}) — the simulation is on fire there ` +
        'and the picture is not',
    )
  } else {
    ok(`all ${inFrame.length} burning places on camera are lit`)
  }

  // 2. The lit region is as wide as the fire is, both ways. Narrower is a disc;
  //    much wider is a smear that says nothing about where the fire is.
  const litWorld = after.spanPx / d.zoom
  const lo = fieldSpan - k.FLAME_RADIUS * 2
  const hi = fieldSpan + k.FLAME_RADIUS * 6
  if (litWorld < lo || litWorld > hi) {
    fail(
      `the lit region is ${litWorld.toFixed(0)} world px wide against a flame field of ` +
        `${fieldSpan.toFixed(0)} px — expected ${lo.toFixed(0)}..${hi.toFixed(0)}`,
    )
  } else {
    ok(`the fire is drawn ${litWorld.toFixed(0)} px wide, against ${fieldSpan.toFixed(0)} px of flames`)
  }

  // 3. The control patch, in the same pair of frames.
  if (ctrlAfter.count > 1) {
    fail(
      `a patch away from the impact gained ${ctrlAfter.count} hot cluster(s) — the whole ` +
        'frame changed, so the readings above prove nothing',
    )
  } else {
    ok(`the control patch gained nothing (${ctrlAfter.count})`)
  }

  // 4. §F10.2's disc is gone at the source, not only hidden.
  if ((d.hazardsDrawn ?? -1) !== 0) {
    fail(`the client is drawing ${d.hazardsDrawn} ground hazard(s) — a molotov leaves flames now`)
  } else {
    ok('no ground-hazard disc is drawn for a molotov')
  }

  await page.evaluate(() => window.__game.freeze(false))

  // --- a full flame field, and what it costs -------------------------------
  //
  // `FLAME_MAX_LIVE` flames each with a light is the worst case for the lightmap
  // and for the wire (160 flames = 3200 `ProjectileMove`/s). Measured here on the
  // **real server** rather than in `perf`: the sandbox loadout has no flame
  // emitter, and granting one there would move the slots five other checks
  // select from. Reported, and gated only on a ceiling generous enough that a
  // loaded box cannot trip it — the number is for the journal (§F10.3), a cap
  // change is the coordinator's.
  const quiet = await frameMs(page, 2)
  await selectWeapon(page, 'flamethrower')
  await standStill(page)
  await page.mouse.move(1180, 380)
  const before = (await dbg()).flamesSpawned ?? 0
  for (let i = 0; i < 110; i++) {
    await page.evaluate('window.__game.fire()')
    await sleep(45)
  }
  const busy = await frameMs(page, 2)
  const dd = await dbg()
  const fieldLive = (dd.mirrorProjectiles ?? []).length
  console.log(
    `  full field: ${fieldLive} live flames (cap ${k.FLAME_MAX_LIVE}, ` +
      `${(dd.flamesSpawned ?? 0) - before} spawned) — frame ${quiet.toFixed(2)} ms quiet, ` +
      `${busy.toFixed(2)} ms with the field (${(1000 / busy).toFixed(0)} fps)`,
  )
  if (fieldLive < k.FLAME_MAX_LIVE / 2) {
    fail(
      `only ${fieldLive} flames stayed alive — the field this measures does not exist, ` +
        'so the frame time above is a measurement of nothing',
    )
  } else {
    ok(`${fieldLive} live flames carried, against a cap of ${k.FLAME_MAX_LIVE}`)
  }
  if (busy > 50) {
    fail(`a full flame field costs ${busy.toFixed(2)} ms/frame — under 20 fps`)
  } else {
    ok(`a full flame field renders at ${(1000 / busy).toFixed(0)} fps`)
  }

  if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
  else ok('no page errors')
} finally {
  await stack.close()
}

if (failures.length) {
  console.error(`\nfire-visible: ${failures.length} failure(s)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('fire-visible ok')
