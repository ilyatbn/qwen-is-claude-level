/**
 * `lava-lights` — T23.19E (rewrites T19.24's): **a lava vent in F's look — its jet drawn over the whole cone that
 * burns, its mouth glowing, and its light on the ground at night — on both tiers.**
 *
 * T19.24's check was networked (`WEATHER=lava`): a vent lit the ground in a real match. Lava is switched off
 * (`LAVA_ENABLED`, owner 2026-09-16) and the server refuses `WEATHER=lava`, so that check could not start (it was
 * `disabled`). Its claim is kept and its path rewritten (R13): the sandbox stands vents in the world
 * (`__game.stageHazards`) through the **same** weather layer and effect lights a match feeds from `lavaVents`
 * (`WorldView.update` → `WeatherLayer`, `EffectLights.frame`), and the world renderer draws them (`fx/hazards.ts`).
 * What it photographed of the old layers — `WeatherLayer.drawFire`'s flat mouth and embers, the MULTIPLY lightmap — is
 * no longer drawn while the world renderer draws the scene.
 *
 * - **Both ends:** two staged vents (one jetting, one burning) → the layer says the world draws them, and the effect
 *   lights hold one `vent` light each.
 * - **The jet covers what burns** (`lava.rs::in_jet`, `fx/hazards.ts::VENT_JET_*`): points along the cone's axis and
 *   edges, out to its height, change when the hazards are hidden (the lights stay: only the drawing is measured).
 *   Control: two photographs of the hidden frame move none.
 * - **The ground is lit** (T19.24's claim), by the light alone: the vents staged with their drawing hidden (the
 *   lights stay) against no vents at all, on the rock beside the jet's foot; a patch far away does not move. (T19.24's
 *   falsification lesson: a patch the drawing reaches scores *higher* with the lights deleted.)
 * - Both tiers (`setHighQuality`), at night. Shots: `lava-lights-{low,full}`.
 */
import { comparePhotos, patchLuminance, photo, toScreen } from './pixels.mjs'

/** Night (`setTime`, s into the sandbox's cycle — the same as `furniture`'s), read back and asserted. */
const NIGHT_T = 90
/** Points along the jet, and across it at this share of its half-angle. */
const AXIS_POINTS = 8
const EDGE_SHARE = 0.8
/** A point counts as painted past this channel change (the pixel harness's own `PIXEL_MOVED` is 6; glows are soft). */
const PAINT = 10
/** The rock patch (world px, half-size) — the solid one nearest the jet light, searched out to `ROCK_REACH`. */
const ROCK_HALF = [8, 5]
const ROCK_REACH = 120
/** The lit ground's mean luminance gain over the unlit, 0–255, and the far patch's allowance. */
const LIT_MIN = 1.5
const FAR_MAX = 0.5

/** The first solid row at or below `y` in column `x` (world px). */
async function groundBelow(page, x, y, span = 300) {
  return page.evaluate(([x, y, span]) => {
    const c = window.__game.core
    for (let d = 0; d < span; d++) if (c.solidAt(Math.round(x), Math.round(y + d))) return Math.round(y + d)
    return null
  }, [x, y, span])
}

export default async function ({ page, shot, log }) {
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  const problems = []
  const hz = await page.evaluate(async () => {
    const m = await import('/src/look/fx/hazards.ts')
    const l = await import('/src/look/effectLights.ts')
    return { H: m.VENT_JET_H, half: m.VENT_JET_HALF, rise: l.VENT_JET_RISE }
  })
  await page.evaluate((t) => window.__game.setTime(t), NIGHT_T)
  const dark = (await page.evaluate(() => window.__game.debug())).darkness
  if (!(dark > 0.5)) problems.push(`setTime(${NIGHT_T}) is not night: darkness ${dark}`)

  const me = (await page.evaluate(() => window.__game.debug())).player
  const jx = me.x + 90
  const jy = await groundBelow(page, jx, me.y - 60)
  const bx = me.x - 90
  const by = await groundBelow(page, bx, me.y - 60)
  if (jy === null || by === null) throw new Error(`no ground beside the player at ${Math.round(me.x)},${Math.round(me.y)}`)
  const vents = [
    { x: jx, y: jy, jetting: true, burning: false, lean: 0.15 },
    { x: bx, y: by, jetting: false, burning: true, lean: 0 },
  ]
  const stage = (v, visible = true) => page.evaluate(([o]) => window.__game.stageHazards(o), [v ? { vents: v, visible } : null])

  // The cone's sample points (world px) — along the axis and near both edges, out to the height.
  const pts = []
  for (let i = 1; i <= AXIS_POINTS; i++) {
    const d = (hz.H * i) / AXIS_POINTS - 6
    for (const off of [-hz.half * EDGE_SHARE, 0, hz.half * EDGE_SHARE]) {
      const a = vents[0].lean + off
      pts.push({ x: jx + Math.sin(a) * d, y: jy - Math.cos(a) * d, d, off })
    }
  }

  for (const hq of [false, true]) {
    const tier = hq ? 'full' : 'low'
    await page.evaluate((v) => window.__game.setHighQuality(v), hq)
    // The tier's lit terrain whole before anything is measured on it (a swap mid-leg reads as a change).
    await page.waitForFunction((t) => window.__world.info().tier === t && window.__world.litTerrain()?.drawn && !window.__game.debug().terrainSwapPending, hq ? 'full' : 'low', { timeout: 60_000 })
    const staged = await stage(vents)
    if (staged.drawnBy !== 'world') problems.push(`${tier}: the vents are drawn by ${staged.drawnBy}, not the world renderer`)
    await page.waitForTimeout(700)
    await page.evaluate(() => window.__game.freeze(true))
    const lights = (await page.evaluate(() => window.__game.effectLights())).filter((l) => l.kind === 'vent')
    const drawnTier = await page.evaluate(() => window.__world.info().tier)
    log(`${tier}: ${lights.length} vent lights for 2 staged vents (the world renderer draws the ${drawnTier} tier)`)
    if (drawnTier !== tier) problems.push(`asked for the ${tier} tier, the world renderer draws ${drawnTier}`)
    if (lights.length !== 2) problems.push(`${tier}: ${lights.length} vent lights in the list for 2 vents`)

    const screen = []
    for (const p of pts) {
      const s = await toScreen(page, p.x, p.y)
      if (s.onScreen) screen.push({ ...p, sx: s.x, sy: s.y })
    }
    if (screen.length < pts.length * 0.75) problems.push(`${tier}: only ${screen.length}/${pts.length} jet points on camera`)
    const drawn = await photo(page)
    await stage(vents, false)
    await page.waitForTimeout(250)
    const hidden = await photo(page)
    const hidden2 = await photo(page)
    const points = screen.map((p) => ({ x: p.sx, y: p.sy }))
    const painted = await comparePhotos(page, drawn, hidden, { points, thr: PAINT })
    const idle = await comparePhotos(page, hidden, hidden2, { points, thr: PAINT })
    const n = painted.points.filter(Boolean).length
    log(`${tier}: ${n}/${points.length} points of the burning cone painted (height ${hz.H}, half-angle ${hz.half}); control ${idle.points.filter(Boolean).length}; per point ${painted.detail.map((d) => d.peak).join(' ')}`)
    if (n !== points.length) {
      const miss = screen.filter((_, i) => !painted.points[i]).map((p) => `${Math.round(p.d)} px ${p.off.toFixed(2)} rad`)
      problems.push(`${tier}: ${points.length - n} points of the burning cone unpainted: ${miss.join('; ')}`)
    }
    if (idle.points.some(Boolean)) problems.push(`${tier}: control — the hidden frame photographed twice "paints" ${idle.points.filter(Boolean).length} points`)
    await stage(vents, true)
    await page.waitForTimeout(250)
    await shot(`lava-lights-${tier}`)

    // The ground beside the jet, lit: the vents' lights alone (drawing hidden) vs no vents — the clock running, so the
    // light list is rebuilt; the frame is otherwise still (the player idle, the sky fixed at night).
    await page.evaluate(() => window.__game.freeze(false))
    await stage(vents, false)
    await page.waitForTimeout(400)
    const rock = await page.evaluate(([cx, cy, hw, hh, reach]) => {
      const c = window.__game.core
      let best = null
      for (let dy = -reach; dy <= reach; dy += 4) {
        for (let dx = -reach; dx <= reach; dx += 4) {
          const d = Math.hypot(dx, dy)
          if (d < 20 || d > reach || (best && d >= best.d)) continue
          let solid = true
          for (let y = -hh; y <= hh && solid; y += 2) for (let x = -hw; x <= hw && solid; x += 2) if (!c.solidAt(Math.round(cx + dx + x), Math.round(cy + dy + y))) solid = false
          if (solid) best = { x: cx + dx, y: cy + dy, d }
        }
      }
      return best
    }, [jx, jy - hz.rise, ROCK_HALF[0], ROCK_HALF[1], ROCK_REACH])
    if (!rock) problems.push(`${tier}: no rock within ${ROCK_REACH} px of the jet light`)
    const g = rock ? await toScreen(page, rock.x, rock.y) : { onScreen: false }
    const far = await toScreen(page, me.x, me.y - 260)
    const rect = (s) => ({ x: Math.round(s.x - ROCK_HALF[0] * s.scale), y: Math.round(s.y - ROCK_HALF[1] * s.scale), w: Math.round(2 * ROCK_HALF[0] * s.scale), h: Math.round(2 * ROCK_HALF[1] * s.scale) })
    if (!g.onScreen || !far.onScreen) problems.push(`${tier}: the ground or far patch is off camera`)
    else {
      const litG = await patchLuminance(page, rect(g))
      const litF = await patchLuminance(page, rect(far))
      // T23.25: **no vents, with the drawing still hidden** — not `stage(null)`, which shows the hazards layer again.
      // The embers the vents threw are still in flight then (their life is sim time; at 3 fps under load it outlasts
      // this wait by seconds), so the "unlit" rock wore the embers: 31.7–58.5 against a lit 29.4, red at −2 to −29,
      // and 22.6 once they had died 1.5 s later. Alone, the embers are gone within the wait; the claim is the light.
      await stage([], false)
      await page.waitForTimeout(400)
      const darkG = await patchLuminance(page, rect(g))
      const darkF = await patchLuminance(page, rect(far))
      const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
      const dG = mean(litG) - mean(darkG)
      const dF = Math.abs(mean(litF) - mean(darkF))
      log(`${tier}: the rock ${Math.round(rock.d)} px from the jet light is lit +${dG.toFixed(2)} (min ${LIT_MIN}); a patch far away moved ${dF.toFixed(2)} (max ${FAR_MAX})`)
      if (!(dG >= LIT_MIN)) problems.push(`${tier}: the vent does not light the ground beside it (+${dG.toFixed(2)})`)
      if (!(dF <= FAR_MAX)) problems.push(`${tier}: a patch far from the vents moved ${dF.toFixed(2)} — the frame is not still`)
    }
    await page.evaluate(() => window.__game.freeze(false))
  }
  await stage(null)
  await page.evaluate(() => window.__game.setHighQuality(false))
  await page.evaluate(() => window.__game.setTime(null))
  if (problems.length) throw new Error(`lava-lights: ${problems.join('; ')}`)
}
