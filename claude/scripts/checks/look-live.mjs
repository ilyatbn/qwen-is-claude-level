/**
 * `look-live` — T23.22 step 2: **Level B, the live game against the pictures** (M23-art.md § Verification).
 *
 * A staged sandbox frame — the game's own scene and renderer (`SandboxScene`, the full tier, zoom 1), `worldlook=classic`
 * — on `SEEDS` (four maps), at night (`hour=1`, F1's end of the blend) and by moonlit day (`hour=0`, F5's). In each: three
 * seated figures stood beside the player (`showSeats`), and the player fires a **laser** (the beam held:
 * `holdTracers`), a **flamethrower** burst and a **bazooka** at the rock ahead; the frame is frozen once the blast's
 * light is in the renderer's list (`effectLights`). The sandbox has one shooter, so the three weapons are one figure's,
 * in sequence — the frame holds the beam, the flame's tail and the blast at once. The world canvas is photographed
 * (`photo` says why not the page).
 *
 * ## What is compared, and against what
 *
 * Each frame against its picture — night against `F1-night-combat.png`, day against `F5-moonlit-day.png` — by
 * **distribution** only (a live map is not the reference's composition): `look-gate.mjs::LIVE_METRICS` — the luminance
 * histogram (W1), p5/p50/p95 luminance, the 8-colour palette's ΔE, the saturation histogram (W1), edge density, the
 * fraction above the bloom threshold. Bounds, `look-gate.mjs::liveBounds`: floor = the largest distance between two of
 * the approved F1/F2/F3 (how far apart one art direction's pictures sit), control = F0 (today's look) against the same
 * picture, bound = their midpoint; a metric whose control does not clear its floor is dropped, by name.
 *
 * **Must fail:** F0 against each picture fails every kept metric by construction of the bound, so the live leg's own
 * control is a frame of the game that is **not** the look: the same staged night frame with the world renderer's
 * grade, bloom and fog hidden (`__world.hideLayers`) — it must fail at least one metric. A gate that passes it cannot
 * see the post stack.
 *
 * Gated: every seed's frame within every kept bound, at both hours. Side by sides in `shots/look-live-*.png`.
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, loadPng } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'
import { LIVE_METRICS, liveBounds, ref, sideBySide } from '../lib/look-gate.mjs'
import { toScreen } from './pixels.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')

/** Four maps (`effect-lights`' 4242 among them). */
const SEEDS = [4242, 7, 1234, 99]
/** The two ends of the day blend (`worldRenderer-math.ts::hourFromUrl`: 1 = F1's night, 0 = F5's moonlit day). */
const HOURS = [
  { hour: 1, name: 'night', picture: 'F1-night-combat.png' },
  { hour: 0, name: 'day', picture: 'F5-moonlit-day.png' },
]
/** Where the seated figures stand, world px either side of the player. */
const SEAT_DX = [-160, 140, 260]
/** How far ahead the bazooka aims (world px), and the laser's aim above it. */
const AIM_DX = 300
/** The control's hidden layers: the post stack. */
const POST = ['grade', 'bloom', 'fogBack', 'fogFront']

const frames = (page, n) =>
  page.evaluate((k) => new Promise((r) => {
    let i = 0
    const f = () => (++i >= k ? r() : requestAnimationFrame(f))
    requestAnimationFrame(f)
  }), n)

/** The first rock below `y0` in column `x` (world px), or null. */
const surface = (page, x, y0) =>
  page.evaluate(([x, y0]) => {
    const c = window.__game.core
    for (let y = Math.max(0, y0); y < c.height; y++) if (c.solidAt(x, y)) return y
    return null
  }, [Math.round(x), Math.round(y0)])

/**
 * Fire the selected weapon on each frame until one is accepted, up to `ms` of wall: a switch leaves a cooldown counted in
 * sim time, which the sandbox steps per drawn frame — so at swiftshader's few fps it lasts seconds (measured: 19 frames
 * were not enough at 3 s).
 */
const fireOnce = (page, ms = 10_000) =>
  page.evaluate(async (ms) => {
    const t0 = performance.now()
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    const rejects = {}
    while (performance.now() - t0 < ms) {
      const e = window.__game.fire()
      if (!e.rejected) return { ok: true, rejects }
      rejects[e.rejected] = (rejects[e.rejected] ?? 0) + 1
      await raf()
    }
    return { ok: false, rejects }
  }, ms)

const select = (page, key) =>
  page.evaluate((k) => {
    const inv = window.__game.inventory()
    const i = inv.slots.findIndex((s) => s && s.key === k)
    window.__game.selectSlot(i)
    return i
  }, key)

async function stage(page, origin, seed, hour, log) {
  await page.goto(`${origin}/?sandbox=1&seed=${seed}&hour=${hour}&worldlook=classic&e2e=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  await page.evaluate(() => window.__game.setZoom(1))
  await frames(page, 30)
  const tier = await page.evaluate(() => window.__world.info().tier)
  if (tier !== 'full') throw new Error(`seed ${seed}: want the full tier, got ${tier}`)
  const me = await page.evaluate(() => window.__game.debug().player)
  const seats = []
  for (const [i, dx] of SEAT_DX.entries()) {
    const y = await surface(page, me.x + dx, me.y - 200)
    if (y !== null) seats.push({ seat: i + 1, x: me.x + dx, y: y - 1 })
  }
  const stood = await page.evaluate((l) => window.__game.showSeats(l), seats)
  for (const k of ['laser_pistol', 'flamethrower', 'bazooka']) {
    if ((await page.evaluate((k) => window.__game.giveItem(k), k)) < 0) throw new Error(`seed ${seed}: could not give ${k}`)
  }
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [me.x + AIM_DX / 2, me.y - 60])
  await frames(page, 5)
  const tx = me.x + AIM_DX
  const ty = (await surface(page, tx, me.y - 150)) ?? me.y
  const fired = []
  // The laser, held.
  await page.evaluate(() => window.__game.holdTracers(true))
  let aim = await toScreen(page, tx, ty - 60)
  await page.mouse.move(aim.x, aim.y)
  await frames(page, 3)
  await select(page, 'laser_pistol')
  await frames(page, 2)
  const laser = await fireOnce(page)
  fired.push(['laser', laser.ok])
  // A flame burst (a dozen frames of the trigger held), then the bazooka at the rock, frozen on the frame its blast's
  // light reaches the list — the beam held, the flame's tail and the blast. (Firing the flame *after* the rocket missed
  // the blast: the rocket lands within the weapon switch's cooldown and its light is gone by the freeze — measured.)
  aim = await toScreen(page, tx, ty - 30)
  await page.mouse.move(aim.x, aim.y)
  await select(page, 'flamethrower')
  const flame = await fireOnce(page)
  const burst = await page.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    let n = 0
    for (let i = 0; i < 12; i++) {
      await raf()
      if (!window.__game.fire().rejected) n++
    }
    return n
  })
  fired.push(['flame', flame.ok && burst > 0])
  aim = await toScreen(page, tx, ty + 4)
  await page.mouse.move(aim.x, aim.y)
  await select(page, 'bazooka')
  const rocket = await fireOnce(page)
  fired.push(['bazooka', rocket.ok])
  if (!rocket.ok || !laser.ok || !flame.ok) log(`    rejected: laser ${JSON.stringify(laser.rejects)}, flame ${JSON.stringify(flame.rejects)}, bazooka ${JSON.stringify(rocket.rejects)}`)
  const blast = await page.evaluate(async () => {
    const t0 = performance.now()
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    while (performance.now() - t0 < 8000) {
      if (window.__game.effectLights().some((l) => l.kind === 'explosion')) break
      await raf()
    }
    window.__game.freeze(true)
    await raf()
    return window.__game.effectLights().map((l) => l.kind)
  })
  log(`    flame burst: ${burst + 1} accepted shots`)
  log(`  seed ${seed} hour ${hour}: ${stood} seated, fired ${JSON.stringify(Object.fromEntries(fired))}, lights at the freeze ${JSON.stringify(blast)}`)
  const problems = []
  for (const [k, ok] of fired) if (!ok) problems.push(`seed ${seed} hour ${hour}: the ${k} did not fire`)
  if (!blast?.includes('explosion')) problems.push(`seed ${seed} hour ${hour}: no explosion light in the frozen frame`)
  if (stood < 2) problems.push(`seed ${seed} hour ${hour}: only ${stood} seated figures stood`)
  return { problems }
}

/**
 * The world canvas (`__world.readFrame`): sky, terrain, cast, effects, fog and post — the look. Not the page: the
 * sandbox's page carries its dev panel, status line and minimap box, which are no part of the game's picture (measured,
 * first run: the panel alone covered a fifth of the frame). The references' HUD is a thin band of text.
 */
const photo = async (page) => {
  const f = await page.evaluate(() => window.__world.readFrame())
  if (f.w !== 1280 || f.h !== 720) throw new Error(`want a 1280x720 world frame, got ${f.w}x${f.h}`)
  return { width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')) }
}

export default async function ({ page, shot, log }) {
  const origin = new URL(page.url()).origin
  const problems = []
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  await page.setViewportSize({ width: 1280, height: 720 })
  const table = []
  for (const h of HOURS) {
    const picture = loadPng(ref(h.picture))
    const { bounds, dropped } = liveBounds(picture)
    log(`${h.name} against ${h.picture}: bounds (floor = F1/F2/F3 spread, control = F0, bound = midpoint)`)
    for (const [k, b] of Object.entries(bounds)) log(`   ${k.padEnd(12)} floor ${b.floor.toFixed(4).padStart(9)}  F0 ${b.control.toFixed(4).padStart(9)}  bound ${b.bound.toFixed(4)}`)
    if (dropped.length) log(`   dropped (F0 does not clear the floor): ${dropped.join(', ')}`)
    for (const seed of SEEDS) {
      const s = await stage(page, origin, seed, h.hour, log)
      problems.push(...s.problems)
      const frame = await photo(page)
      sideBySide(frame, picture, `look-live-${h.name}-${seed}.png`)
      const m = compare(frame, picture)
      const bad = Object.keys(bounds).filter((k) => !(m[k] <= bounds[k].bound))
      table.push({ h: h.name, seed, m, bad })
      log(`   ${h.name} seed ${String(seed).padEnd(5)} ${LIVE_METRICS.filter((k) => k in bounds).map((k) => `${k} ${m[k].toFixed(4)}${bad.includes(k) ? '!' : ''}`).join('  ')}`)
      if (bad.length) problems.push(`${h.name} seed ${seed}: outside the live bounds on ${bad.join(', ')} (shots/look-live-${h.name}-${seed}.png)`)
      if (h.hour === 1 && seed === SEEDS[0]) {
        // The control: the same frozen frame without the post stack.
        await page.evaluate((l) => window.__world.hideLayers(l), POST)
        await frames(page, 3)
        const c = await photo(page)
        await page.evaluate(() => window.__world.hideLayers([]))
        sideBySide(c, picture, 'look-live-control-no-post.png')
        const cm = compare(c, picture)
        const cbad = Object.keys(bounds).filter((k) => !(cm[k] <= bounds[k].bound))
        log(`   control (grade, bloom, fog hidden), seed ${seed}: fails ${cbad.length}/${Object.keys(bounds).length} (${cbad.join(', ') || 'none'})  ${LIVE_METRICS.filter((k) => k in bounds).map((k) => `${k} ${cm[k].toFixed(4)}`).join('  ')}`)
        if (!cbad.length) problems.push('control: the frame without its post stack passes every live bound — the gate cannot see the look')
      }
    }
  }
  await shot('look-live')
  if (problems.length) throw new Error(problems.join('\n'))
}
