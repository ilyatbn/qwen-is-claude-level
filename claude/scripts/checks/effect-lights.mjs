/**
 * `effect-lights` — T23.09: **the effects are the lights.** A real bazooka blast, a real laser beam and
 * a real jetpack burn in the sandbox each raise the lit terrain's luminance near them, in the world
 * canvas's own pixels, and leave rock far outside the light's radius alone.
 *
 * ## One frame, both ways
 *
 * Each leg fires the real thing, waits until the effect's light is in the list the scene handed the
 * world renderer (`__game.effectLights()`, kind by kind) **and** the terrain drew with at least one light
 * (`__world.litTerrain().lights` ≥ 1, asserted on every leg), then freezes the scene (update stops; the world canvas
 * still draws). The frozen frame is read twice — as drawn, and with **only that light** taken out of the
 * lights the terrain drew (`__world.drawnLights`, `setLights`; every other drawn light kept, no actors in either read —
 * T23.19G) — so the crater, the camera, the sky and the fog are the same
 * pixels in both and **the only difference is the light**.
 *
 * ## 4. Through `GameScene` (T23.09C F6)
 *
 * The same lights built in a networked match, two clients (cal, dee), standard gravity, `DEV_LOADOUT`: dee burns his
 * pack and cal's list carries a `jet` light at **cal's view of dee's flame** (a remote's jet, off the wire's flag) —
 * held by cal's renderer too; then dee fires the smg and every muzzle light cal lists sits at a drawn body's gun
 * (networked rounds, T23.09C F2: they flashed ~speed × latency ahead, or in mid-air at a late join), with at least one
 * seen (the presence control). T23.35: and again with dee firing **while falling** from a climb — at least one muzzle light seen while
 * cal's drawn dee moves at `FAST` px/s or more, every one within `MUZZLE_REACH` of a drawn body.
 *
 * - **Near:** rock pixels (`core.solidAt`) within `NEAR_FRAC` of the light's radius of it gain at least
 *   `NEAR_MIN` in mean luminance (0–255).
 * - **Far (control region):** rock pixels more than the radius + `FAR_MARGIN` away move by at most
 *   `FAR_MAX` on any channel — the light is a light, not an exposure change. Each leg needs `MIN_ROCK`
 *   rock pixels in both regions, or it says it has nothing to measure rather than passing.
 * - **Decay (the blast's):** unfrozen until the explosion has left the list, frozen again: the near
 *   region's gain is back under `FAR_MAX` — the light lived the blast's life and no longer.
 *
 * The camera is zoomed to 1 (R6's zoom, T23.10's to make the default) so the blast's 460 px radius fits
 * inside the view with rock beyond it. Low tier, as every browser check names (R20).
 */
import { toScreen } from './pixels.mjs'

/** Mean luminance gain near a light, rock only, 0–255. Measured (T23.09 journal); the floor sits under the weakest leg. */
const NEAR_MIN = 4
/** Nearest region: within this fraction of the light's radius (falloff (1 − d/r)², so the inner part carries it). */
const NEAR_FRAC = 0.6
/** Control region: rock this far beyond the light's radius (world px) — clear of bloom's spread. */
const FAR_MARGIN = 120
/** Largest channel change allowed in the control region (the frames are the same frozen scene). */
const FAR_MAX = 3
/** The decay leg re-measures once the blast's light is at or under this fraction of its first intensity… */
const DECAY_AT = 0.5
/** …and wants the near gain under this fraction of the first (linear decay ⇒ ~DECAY_AT; room for the tonemap's curve). */
const DECAY_GAIN = 0.8
/** How far above the ground the jet leg's burn has carried the body when its light is first listed (measured: ~65 px). */
const JET_RISE = 60
/** The jet leg places the player this far (world px) above the ground under it before burning. */
const JET_HOVER = 20
/** Rock pixels (buffer) a region needs before its number means anything. */
const MIN_ROCK = 150

const decode = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')), view: f.view })
const luma = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]
const frames = (page, n) =>
  page.evaluate((k) => new Promise((r) => {
    let i = 0
    const f = () => (++i >= k ? r() : requestAnimationFrame(f))
    requestAnimationFrame(f)
  }), n)

/**
 * The frozen frame as drawn, and again with **only `light`** taken out of the lights the terrain drew (every other
 * light — gates, other effects — stays, so the difference is this light's alone), plus a rock mask on the
 * buffer grid. Throws if the light is not in the renderer's list: the scene's list and the renderer's must
 * agree (both ends).
 */
async function bothWays(page, light) {
  const held = await page.evaluate(() => window.__world.lights())
  const same = (l) => l.x === light.x && l.y === light.y && l.r === light.r && l.i === light.i
  if (held.filter(same).length !== 1) throw new Error(`the light is not in the renderer's list once: ${JSON.stringify(light)} in ${JSON.stringify(held)}`)
  // T23.19G: the control frame is the **drawn** set without the light, not the held list without it. The held list can be
  // longer than the terrain's slots (a map's gates + a shot's muzzle + its impact: 14 against the low tier's 10), and
  // taking one out of it lets a light that had lost its slot take it: the gate at (1312, 719), 676 px from the laser's
  // impact, lit its rock in the control frame only (+24 on a channel) — read as "the whole frame moved".
  const drawn = await page.evaluate(() => window.__world.drawnLights())
  const rest = drawn.filter((l) => !same(l))
  if (rest.length !== drawn.length - 1) throw new Error(`both ends — the light is held but the terrain did not draw it once: ${JSON.stringify(light)} in ${JSON.stringify(drawn)}`)
  // T23.19G: no figures, gates or pickups in either read. The actors are lit by the renderer's whole list, uncapped, so the
  // drawn set above (without the gate lights that lost their slots) re-lit the gate at (1312, 719) in the control frame
  // only (+47 on its orb). The rock under them is what is measured.
  await page.evaluate(() => window.__world.setActors([]))
  const on = decode(await page.evaluate(() => window.__world.readFrame()))
  await page.evaluate((l) => window.__world.setLights(l), rest)
  const off = decode(await page.evaluate(() => window.__world.readFrame()))
  await page.evaluate((l) => window.__world.setLights(l), held)
  await page.evaluate(() => window.__world.setActors(null))
  const rock = await page.evaluate(([v, w, h]) => {
    const c = window.__game.core
    const k = w / v.w
    let s = ''
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) s += c.solidAt(Math.floor(v.x + (x + 0.5) / k), Math.floor(v.y + (y + 0.5) / k)) ? '1' : '0'
    return s
  }, [on.view, on.width, on.height])
  if (JSON.stringify(on.view) !== JSON.stringify(off.view)) throw new Error(`the camera moved between the two reads: ${JSON.stringify(on.view)} ${JSON.stringify(off.view)}`)
  return { on, off, rock }
}

/** Near gain and far change around `light`, rock pixels only. */
function measure({ on, off, rock }, light) {
  const k = on.width / on.view.w
  const near = { n: 0, gain: 0 }
  const far = { n: 0, max: 0 }
  for (let y = 0; y < on.height; y++) {
    for (let x = 0; x < on.width; x++) {
      if (rock[y * on.width + x] !== '1') continue
      const d = Math.hypot(on.view.x + (x + 0.5) / k - light.x, on.view.y + (y + 0.5) / k - light.y)
      const o = (y * on.width + x) * 4
      if (d < light.r * NEAR_FRAC) {
        near.n++
        near.gain += luma(on.data, o) - luma(off.data, o)
      } else if (d > light.r + FAR_MARGIN) {
        far.n++
        for (let c = 0; c < 3; c++) far.max = Math.max(far.max, Math.abs(on.data[o + c] - off.data[o + c]))
      }
    }
  }
  near.gain = near.n ? near.gain / near.n : 0
  return { near, far }
}

/** Wait (in page, frame by frame) until the list holds `kind`, one more frame so the terrain drew it, then freeze. */
async function freezeWith(page, kind, timeout = 8000) {
  const got = await page.evaluate(
    async ([want, ms]) => {
      const t0 = performance.now()
      const raf = () => new Promise((r) => requestAnimationFrame(r))
      while (performance.now() - t0 < ms) {
        await raf()
        if (window.__game.effectLights().some((l) => l.kind === want)) {
          await raf()
          window.__game.freeze(true)
          await raf()
          return window.__game.effectLights().find((l) => l.kind === want) ?? null
        }
      }
      return null
    },
    [kind, timeout],
  )
  if (!got) return null
  const lit = await page.evaluate(() => window.__world.litTerrain())
  return { light: got, lit }
}

/** Where the rock surface is in column `x` below `y0` (world px), or null. */
const surface = (page, x, y0) =>
  page.evaluate(([x, y0]) => {
    const c = window.__game.core
    for (let y = Math.max(0, y0); y < c.height; y++) if (c.solidAt(x, y)) return y
    return null
  }, [x, y0])

function judge(name, m, problems, log) {
  log(`${name}: near ${m.near.n} rock px, mean luminance gain ${m.near.gain.toFixed(2)} (min ${NEAR_MIN}); far ${m.far.n} rock px, max channel change ${m.far.max} (max ${FAR_MAX})`)
  if (m.near.n < MIN_ROCK) problems.push(`${name}: only ${m.near.n} rock px near the light — nothing to measure (min ${MIN_ROCK})`)
  else if (!(m.near.gain >= NEAR_MIN)) problems.push(`${name}: the rock near the light gains only ${m.near.gain.toFixed(2)} luminance (min ${NEAR_MIN}) — the effect does not light the terrain`)
  if (m.far.n < MIN_ROCK) problems.push(`${name}: control — only ${m.far.n} rock px beyond the light's radius (min ${MIN_ROCK})`)
  else if (m.far.max > FAR_MAX) problems.push(`${name}: control — rock beyond the light's radius changed by ${m.far.max} (max ${FAR_MAX}); the whole frame moved`)
}

export default async function ({ page, shot, log }) {
  const problems = []
  await page.evaluate(() => window.__game.setZoom(1))
  await frames(page, 3)
  const zoom = await page.evaluate(() => window.__game.debug().zoom ?? window.__game.debug().worldView.width)
  const lt = await page.evaluate(() => window.__world.litTerrain())
  if (!lt?.drawn) throw new Error(`the lit terrain is not drawn: ${JSON.stringify(lt)}`)
  log(`zoom ${JSON.stringify(zoom)}, lit terrain ${JSON.stringify(lt)}`)
  const idle = await page.evaluate(() => window.__game.effectLights())
  log(`idle list: ${JSON.stringify(idle.map((l) => l.kind))}`)

  // ------------------------------------------------------------ 1. the bazooka at rock
  const me = await page.evaluate(() => window.__game.debug().player)
  // The camera held still on the player (the rig leads the aim): the decay frame must be the same view.
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [me.x, me.y])
  await frames(page, 3)
  const tx = Math.round(me.x + 260)
  const ty = await surface(page, tx, Math.round(me.y - 120))
  if (ty === null) throw new Error(`no rock under x ${tx} to shoot at`)
  const aim = await toScreen(page, tx, ty + 4)
  await page.mouse.move(aim.x, aim.y)
  await frames(page, 3)
  await page.evaluate(() => {
    const inv = window.__game.inventory()
    window.__game.selectSlot(inv.slots.findIndex((s) => s && s.key === 'bazooka'))
  })
  const fired = await page.evaluate(() => window.__game.fire())
  log(`bazooka at (${tx}, ${ty}) from (${Math.round(me.x)}, ${Math.round(me.y)}): ${JSON.stringify(fired?.projectile ?? fired)}`)
  const blast = await freezeWith(page, 'explosion')
  if (!blast) problems.push('bazooka: no explosion light reached the list within 8 s of the shot')
  else {
    log(`explosion light ${JSON.stringify(blast.light)}; terrain drew ${blast.lit.lights} light(s)`)
    if (!(blast.lit.lights >= 1)) problems.push(`bazooka: both ends — the list has the explosion but the terrain drew ${blast.lit.lights} lights`)
    const both = await bothWays(page, blast.light)
    judge('bazooka blast', measure(both, blast.light), problems, log)
    await shot('effect-lights-blast')
    // Decay, in pixels: the same blast later in its life, against its own same-frame control (the blast
    // shakes the camera, so frames across time are not comparable pixel for pixel) — the gain falls with
    // the light's intensity. Then gone: once the scene drops it, the renderer holds no light there.
    const m1 = measure(both, blast.light)
    await page.evaluate(() => window.__game.freeze(false))
    const later = await page.evaluate(async ([i0, at]) => {
      const t0 = performance.now()
      const raf = () => new Promise((r) => requestAnimationFrame(r))
      while (performance.now() - t0 < 5000) {
        await raf()
        const l = window.__game.effectLights().find((e) => e.kind === 'explosion')
        if (!l) return null
        if (l.i <= i0 * at) {
          await raf()
          window.__game.freeze(true)
          await raf()
          return window.__game.effectLights().find((e) => e.kind === 'explosion') ?? null
        }
      }
      return null
    }, [blast.light.i, DECAY_AT])
    if (!later) problems.push(`bazooka: never saw the explosion light at or under ${DECAY_AT} of its first intensity — it does not decay, or was gone at once`)
    else {
      const m2 = measure(await bothWays(page, later), later)
      log(`bazooka, later: light i ${later.i.toFixed(2)} (was ${blast.light.i.toFixed(2)}), near gain ${m2.near.gain.toFixed(2)} (was ${m1.near.gain.toFixed(2)})`)
      if (!(m2.near.gain < m1.near.gain * DECAY_GAIN)) problems.push(`bazooka: the lit rock did not dim with the blast's light: gain ${m2.near.gain.toFixed(2)} later against ${m1.near.gain.toFixed(2)}`)
    }
    await page.evaluate(() => window.__game.freeze(false))
    const gone = await page.evaluate(async ([x, y]) => {
      const t0 = performance.now()
      while (performance.now() - t0 < 5000) {
        await new Promise((r) => requestAnimationFrame(r))
        if (!window.__game.effectLights().some((e) => e.kind === 'explosion')) {
          await new Promise((r) => requestAnimationFrame(r))
          return { ms: performance.now() - t0, held: window.__world.lights().filter((l) => Math.hypot(l.x - x, l.y - y) < 1).length }
        }
      }
      return null
    }, [blast.light.x, blast.light.y])
    log(`bazooka, after the blast: ${JSON.stringify(gone)}`)
    if (!gone) problems.push('bazooka: the explosion light was still in the list 5 s after the blast')
    else if (gone.held !== 0) problems.push(`bazooka: the scene dropped the blast's light but the renderer still holds ${gone.held} there`)
    await page.evaluate(() => window.__game.freeze(false))
  }

  // ------------------------------------------------------------ 2. a laser beam at rock
  const slot = await page.evaluate(() => window.__game.giveLaser())
  if (!(slot >= 0)) throw new Error('the sandbox would not give a laser pistol')
  await page.evaluate((s) => window.__game.selectSlot(s), slot)
  await page.evaluate(() => window.__game.holdTracers(true))
  const me2 = await page.evaluate(() => window.__game.debug().player)
  const lx = Math.round(me2.x - 240)
  const ly = await surface(page, lx, Math.round(me2.y - 120))
  if (ly === null) throw new Error(`no rock under x ${lx} to shoot the laser at`)
  const aim2 = await toScreen(page, lx, ly + 6)
  await page.mouse.move(aim2.x, aim2.y)
  await frames(page, 3)
  const shotL = await page.evaluate(async () => {
    const t0 = performance.now()
    let ev = null
    while (performance.now() - t0 < 5000) {
      ev = window.__game.fire()
      if (ev?.hitscan?.length) return { hitscan: ev.hitscan }
      await new Promise((r) => requestAnimationFrame(r))
    }
    return { last: ev, inv: window.__game.inventory() }
  })
  if (!shotL.hitscan) problems.push(`laser: the pistol fired no beam: ${JSON.stringify(shotL)}`)
  else {
    log(`laser beam ${JSON.stringify(shotL.hitscan[0])}`)
    const beam = await freezeWith(page, 'laser')
    if (!beam) problems.push('laser: no laser-impact light reached the list')
    else {
      log(`laser-impact light ${JSON.stringify(beam.light)}; terrain drew ${beam.lit.lights}`)
      if (!(beam.lit.lights >= 1)) problems.push(`laser: both ends — the list has the impact but the terrain drew ${beam.lit.lights} lights`)
      judge('laser impact', measure(await bothWays(page, beam.light), beam.light), problems, log)
      await shot('effect-lights-laser')
    }
  }
  await page.evaluate(() => window.__game.holdTracers(false))
  await page.evaluate(() => window.__game.freeze(false))
  await frames(page, 30) // the held beam's light is gone once released: nothing left to confound the jet

  // ------------------------------------------------------------ 3. a jetpack burn over rock
  // Low over flat-ish rock: placed a little above the ground under it and jetting at once (airborne, so
  // no jump first) — the plume's light is 100 px, and a burn begun from a standing jump is ~60 px up.
  // T23.14: the jet light sat at the pack's feet (F's `L(ex − 4, ey − 4 …)`) — T23.14B moved it to the flame's glow, a
  // few px from there on an upright burn — in the sandbox too now that it draws the
  // body at the body (it hung it half a body up), so the burn is taken where rock lies within the light's near radius
  // of the height the burn reaches (JET_RISE) — not under the player's spawn, where an overhang above had supplied it.
  const me3 = await page.evaluate(() => window.__game.debug().player)
  const pick = await page.evaluate(([x0, rise, r]) => {
    const c = window.__game.core
    let best = null
    for (let x = Math.round(x0) - 400; x <= x0 + 400; x += 16) {
      let gy = null
      for (let y = 40; y < c.height - 2; y++) if (c.solidAt(x, y) && !c.solidAt(x, y - 1)) { let air = true; for (let k = 2; k < 90 && air; k += 4) air = !c.solidAt(x, y - k); if (air) { gy = y; break } }
      if (gy === null) continue
      let n = 0
      for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) if (dx * dx + dy * dy <= r * r && c.solidAt(x + dx, gy - rise + dy)) n++
      if (!best || n > best.n) best = { x, gy, n }
    }
    return best
  }, [me3.x, JET_RISE, Math.round(100 * NEAR_FRAC)])
  if (!pick) throw new Error('no rock to burn over for the jet leg')
  const gy = pick.gy
  await page.evaluate(([x, y]) => window.__game.place(x, y), [pick.x, gy - JET_HOVER])
  log(`jet leg: ground at y ${gy} under x ${pick.x} (${pick.n} rock samples near where the burn reaches); placed at ${gy - JET_HOVER}; now ${JSON.stringify(await page.evaluate(() => window.__game.debug().player))}`)
  await page.keyboard.down('Space')
  const jet = await freezeWith(page, 'jet', 4000)
  await page.keyboard.up('Space')
  if (!jet) problems.push('jet plume: no jet light reached the list while jetting')
  else {
    log(`jet light ${JSON.stringify(jet.light)}; terrain drew ${jet.lit.lights}; list ${JSON.stringify((await page.evaluate(() => window.__game.effectLights())).map((l) => l.kind))}`)
    if (!(jet.lit.lights >= 1)) problems.push(`jet plume: both ends — the list has the jet but the terrain drew ${jet.lit.lights} lights`)
    // T23.14B: the flame's additive glow (and its bloom) sits on the rock right under the burn in both reads, and was
    // measured to take the light's near gain from 7.29 to 2.60 there. Hidden for both reads (the frozen scene keeps
    // the light in the renderer's list), so this leg measures the light alone, as its doc says; `jet-flame` measures
    // the flame whole — flame, glow and light against none.
    await page.evaluate(() => window.__game.showThrusters(false))
    judge('jet plume', measure(await bothWays(page, jet.light), jet.light), problems, log)
    await page.evaluate(() => window.__game.showThrusters(true))
    await shot('effect-lights-jet')
  }
  await page.evaluate(() => window.__game.freeze(false))
  await page.evaluate(() => window.__game.watch(null))

  // ------------------------------------------------------------ 4. through GameScene: a remote's jet, networked rounds
  await matchLegs(problems, log)

  if (problems.length) throw new Error(`effect-lights:\n  - ${problems.join('\n  - ')}`)
}

/** §4: a muzzle light is at a gun within this many px of a drawn body's centre (the smg's muzzle is ~30 px out). */
const MUZZLE_REACH = 48
/** §4: frames cal watches while dee fires, and dee's bursts. */
const MATCH_FRAMES = 90
/** §4c (T23.35): how long dee climbs before he falls firing, the frames cal watches, and the drawn speed (px/s) that counts as moving fast. */
const CLIMB_MS = 1500
const MOVING_FRAMES = 90
const FAST = 250

async function matchLegs(problems, log) {
  const { startStack, freePort, privateMatch, selectWeapon } = await import('./harness.mjs')
  const stack = await startStack({
    port: await freePort(),
    label: 'effect-lights-match',
    env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', DEV_WARMUP_SECONDS: '2', ROUND_SECONDS: '300', DEV_LOADOUT: '1', DEV_START_HEALTH: '100000' },
  })
  try {
    const [cal, dee] = await privateMatch(stack, ['cal', 'dee'], 'Standard')
    await cal.page.waitForFunction(() => window.__game.debug().phase === 'playing', null, { timeout: 60_000 })
    await cal.page.waitForFunction((id) => (window.__game.debug().flames ?? {})[id] !== undefined, dee.id, { timeout: 30_000 })
    // (a) dee burns: cal's list has a jet light at cal's view of dee's flame, and cal's renderer holds it.
    await dee.page.keyboard.down('Space')
    let jet = null
    try {
      jet = await cal.page
        .waitForFunction((id) => {
          const f = (window.__game.debug().flames ?? {})[id]
          if (!f?.drawn || !f.at) return null
          const l = window.__game.effectLights().find((e) => e.kind === 'jet' && Math.hypot(e.x - f.at.x, e.y - f.at.y) < 0.01)
          if (!l) return null
          const held = window.__world.lights().filter((h) => h.x === l.x && h.y === l.y && h.r === l.r).length
          return { light: l, flame: f.at, held, terrain: window.__world.litTerrain()?.lights ?? null }
        }, dee.id, { timeout: 15_000, polling: 'raf' })
        .then((h) => h.jsonValue())
        .catch(() => null)
    } finally {
      await dee.page.keyboard.up('Space')
    }
    log(`4a. dee's jet on cal's client: ${JSON.stringify(jet)}`)
    if (!jet) problems.push("match: cal never listed a jet light at his view of dee's flame while dee burned")
    else if (jet.held !== 1) problems.push(`match: the remote jet light is in cal's list but his renderer holds it ${jet.held} times`)
    // (b) dee fires the smg in bursts; cal watches every frame's muzzle lights against the drawn bodies.
    // T23.32: a held Space climbs now, so (a)'s burn left dee in the air, and (b) fired from a moving body: the light
    // and cal's drawn dee parted by 87 px (red alone at 6c9b306; dee's muzzle y 384–423 against ~452 standing in every
    // gate before the merge — why a moving gunner's light leaves his drawn body is not measured). (b) is the gun-on-a-standing-body
    // case it was written for — dee lands first, and cal's view of him settles. A moving gunner is (c) (T23.35).
    await dee.page.waitForFunction(() => window.__game.debug().player?.grounded === true, null, { timeout: 15_000 })
    await cal.page.waitForTimeout(500)
    await selectWeapon(dee.page, 'smg')
    await dee.page.evaluate(() => {
      window.__burst = setInterval(() => window.__game.fire(), 50)
    })
    const seen = await cal.page.evaluate((N) => new Promise((res) => {
      const out = { frames: 0, muzzles: 0, far: 0, farAt: null }
      const f = () => {
        const d = window.__game.debug()
        const bodies = d.drawnPlayers ?? []
        for (const l of window.__game.effectLights().filter((e) => e.kind === 'muzzle')) {
          out.muzzles++
          const near = Math.min(...bodies.map((b) => Math.hypot(l.x - b.x, l.y - b.y)))
          if (near > out.far) {
            out.far = near
            out.farAt = { x: l.x, y: l.y }
          }
        }
        if (++out.frames < N) requestAnimationFrame(f)
        else res(out)
      }
      requestAnimationFrame(f)
    }), MATCH_FRAMES)
    await dee.page.evaluate(() => clearInterval(window.__burst))
    log(`4b. dee's smg on cal's client: ${seen.muzzles} muzzle lights over ${seen.frames} frames; farthest ${seen.far.toFixed(1)} px from a drawn body (max ${MUZZLE_REACH}) ${JSON.stringify(seen.farAt)}`)
    if (seen.muzzles === 0) problems.push("match: dee's smg fire put no muzzle light in cal's list (the presence control)")
    else if (seen.far > MUZZLE_REACH) problems.push(`match: a networked round flashed ${seen.far.toFixed(1)} px from any drawn body — not at the gun`)
    // (c) T23.35: dee fires **while moving fast** — falling from a climb — and every muzzle light cal lists is still at
    // a drawn body's gun, by (b)'s bound. The server spawns a round at its own body; cal draws dee an interpolation delay
    // behind it, so before T23.35 a falling gunner's flash hung ~87 px off his figure (`render/muzzle-math.ts::gunOrigin`).
    // Its presence control: muzzle lights seen while cal's drawn dee was moving at least `FAST` px/s.
    // Up first, then fire on the way down: a fall is the fast case (the 87 px it was filed at); a climb is slow.
    await dee.page.keyboard.down('Space')
    await dee.page.waitForTimeout(CLIMB_MS)
    await dee.page.keyboard.up('Space')
    await dee.page.evaluate(() => {
      window.__burst = setInterval(() => window.__game.fire(), 50)
    })
    let moving
    try {
      moving = await cal.page.evaluate(([N, id, fast]) => new Promise((res) => {
        const out = { frames: 0, muzzles: 0, fastMuzzles: 0, far: 0, farAt: null, topSpeed: 0 }
        let prev = null
        const f = () => {
          const d = window.__game.debug()
          const bodies = d.drawnPlayers ?? []
          const me = bodies.find((b) => b.id === id)
          const t = performance.now()
          const speed = me && prev && t > prev.t ? (Math.hypot(me.x - prev.x, me.y - prev.y) * 1000) / (t - prev.t) : 0
          prev = me ? { x: me.x, y: me.y, t } : null
          out.topSpeed = Math.max(out.topSpeed, speed)
          for (const l of window.__game.effectLights().filter((e) => e.kind === 'muzzle')) {
            out.muzzles++
            if (speed >= fast) out.fastMuzzles++
            const near = Math.min(...bodies.map((b) => Math.hypot(l.x - b.x, l.y - b.y)))
            if (near > out.far) {
              out.far = near
              out.farAt = { x: l.x, y: l.y, speed: Math.round(speed) }
            }
          }
          if (++out.frames < N) requestAnimationFrame(f)
          else res(out)
        }
        requestAnimationFrame(f)
      }), [MOVING_FRAMES, dee.id, FAST])
    } finally {
      await dee.page.evaluate(() => clearInterval(window.__burst))
    }
    log(`4c. dee's smg while moving on cal's client: ${moving.muzzles} muzzle lights (${moving.fastMuzzles} at ≥ ${FAST} px/s; top ${moving.topSpeed.toFixed(0)} px/s) over ${moving.frames} frames; farthest ${moving.far.toFixed(1)} px from a drawn body (max ${MUZZLE_REACH}) ${JSON.stringify(moving.farAt)}`)
    if (moving.fastMuzzles === 0) problems.push(`match: no muzzle light seen while dee moved at ≥ ${FAST} px/s (top ${moving.topSpeed.toFixed(0)}) — the moving leg measured nothing`)
    else if (moving.far > MUZZLE_REACH) problems.push(`match: a moving gunner's round flashed ${moving.far.toFixed(1)} px from any drawn body — not at the gun`)
    for (const c of [cal, dee]) if (c.errors?.length) problems.push(`match: ${c.name} page errors: ${c.errors.join(' | ')}`)
  } catch (e) {
    problems.push(`match: ${e?.message ?? e}`)
  } finally {
    await stack.close()
  }
}
