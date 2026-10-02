/**
 * `graves` (T23.36, owner: *"add a glow around the tombstone with the same color as the players"*) — on pixels, in
 * the sandbox: two graves of two owners (seats 0 and 1: the red and the teal scarf) staged on the ground either side
 * of the player, at night and at noon. Each grave's ring (round its halo's centre, the stone excluded) is read with
 * the glow and **without it — the same stones, the glow layer off** (`stageFurniture({ glow: false })`), the control
 * frame. What the glow adds to a ring must be that grave's colour: more red than green and blue round the red seat's
 * stone, more green and blue than red round the teal one, and the two additions must differ. A patch as far off on the
 * same frames must not move (the control region).
 *
 * That only a player's last grave stays is `graves-live.mjs` (a real server, real deaths).
 */
import { toScreen, patchRGBA } from './pixels.mjs'

/** `setTime` (s into the cycle) for the night leg — the furniture check's; noon is searched for (darkness 0). */
const NIGHT_T = 90
/** The ring: world px round the halo's centre (14 up the stone, `cell.ts`), outside the stone grown by 3. */
const RING = 22
/**
 * The least mean lift (0–255) of the grave's own colour channel(s) over the ring with the glow on, against off.
 * Measured (T23.36, seed 31337, low tier) in the journal; the floor sits well under both legs' smallest.
 */
const LIFT_MIN = { night: 3, noon: 2 }
/** A control patch on the same two frames may move this much (mean |Δ| per channel, frame noise). */
const CONTROL_MAX = 0.6
/** The scarf colours of seats 0 and 1 (`playerView.ts::SCARF_COLOURS`) — read back off the layer, and asserted. */
const SEATS = { 0: '#e8482c', 1: '#18c2b8' }

async function groundBelow(page, x, y, span = 200) {
  return page.evaluate(([x, y, span]) => {
    const c = window.__game.core
    for (let d = 0; d < span; d++) if (c.solidAt(Math.round(x), Math.round(y + d))) return Math.round(y + d)
    return null
  }, [x, y, span])
}

async function rectOf(page, x0, y0, x1, y1) {
  const a = await toScreen(page, x0, y0)
  const b = await toScreen(page, x1, y1)
  if (!a.onScreen || !b.onScreen) return null
  return { x: Math.round(a.x), y: Math.round(a.y), w: Math.max(4, Math.round(b.x - a.x)), h: Math.max(4, Math.round(b.y - a.y)) }
}

/** Mean RGB of `rgba` over the pixels of `ring` outside `hole` (both screen rects). */
function meanRing(rgba, ring, hole) {
  const s = [0, 0, 0]
  let n = 0
  for (let y = 0; y < ring.h; y++) {
    for (let x = 0; x < ring.w; x++) {
      const sx = ring.x + x
      const sy = ring.y + y
      if (hole && sx >= hole.x && sx < hole.x + hole.w && sy >= hole.y && sy < hole.y + hole.h) continue
      const i = (y * ring.w + x) * 4
      s[0] += rgba[i]
      s[1] += rgba[i + 1]
      s[2] += rgba[i + 2]
      n++
    }
  }
  return n ? s.map((v) => v / n) : [NaN, NaN, NaN]
}

export default async function ({ page, shot, log }) {
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn, null, { timeout: 120_000 })
  const problems = []
  const k = await page.evaluate(() => window.__game.constants())
  const me = (await page.evaluate(() => window.__game.debug())).player
  const at = []
  for (const [owner, dx] of [[0, -70], [1, 70]]) {
    const gx = me.x + dx
    const gy = await groundBelow(page, gx, me.y - 40)
    if (gy === null) throw new Error(`no ground at ${Math.round(gx)} beside the player`)
    at.push({ owner, x: gx, feet: gy })
  }
  // Framed on the two graves (the player stands near the bottom of the view otherwise, the stones under the HUD).
  const view = { x: me.x, y: Math.min(...at.map((g) => g.feet)) - 50 }
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [view.x, view.y])
  const stage = (glow) =>
    page.evaluate(([gs, glow]) => window.__game.stageFurniture({ graves: gs, glow }), [at.map((g) => ({ x: g.x, y: g.feet - k.TOMBSTONE_H / 2, owner: g.owner })), glow])
  const staged = await stage(true)
  if (staged.graves !== 2) problems.push(`staged 2 graves, the layer holds ${staged.graves}`)
  for (const g of at) {
    const d = staged.drawn.find((v) => v.owner === g.owner)
    if (!d) problems.push(`no grave of seat ${g.owner} drawn`)
    else if (d.glow !== SEATS[g.owner]) problems.push(`seat ${g.owner}'s grave glows ${d.glow}, its scarf is ${SEATS[g.owner]}`)
  }
  if (!staged.inWorld) problems.push('the graves are not drawn by the world renderer')

  /** One leg: each ring's mean RGB with the glow and without, on two frozen frames, and a control patch's. */
  async function leg(name) {
    await page.evaluate(() => window.__game.freeze(false))
    await stage(true)
    await page.waitForTimeout(500)
    await page.evaluate(() => window.__game.freeze(true))
    const rects = []
    for (const g of at) {
      const hc = g.feet - 14
      const ring = await rectOf(page, g.x - RING, hc - RING, g.x + RING, hc + RING)
      const stone = await rectOf(page, g.x - k.TOMBSTONE_W / 2 - 3, g.feet - k.TOMBSTONE_H - 3, g.x + k.TOMBSTONE_W / 2 + 3, g.feet + 3)
      if (!ring || !stone) throw new Error(`${name}: seat ${g.owner}'s grave is off camera`)
      rects.push({ g, ring, stone })
    }
    // The control region: a ring's size, well above the player (sky or rock, nothing staged there).
    const ctl = await rectOf(page, view.x - RING, view.y - 110 - RING, view.x + RING, view.y - 110 + RING)
    const read = async () => ({
      rings: await Promise.all(rects.map(async (r) => meanRing((await patchRGBA(page, r.ring)).rgba, r.ring, r.stone))),
      ctl: ctl ? meanRing((await patchRGBA(page, ctl)).rgba, ctl, null) : null,
    })
    const on = await read()
    await shot(`graves-${name}`)
    await stage(false)
    await page.waitForTimeout(400)
    const off = await read()
    await shot(`graves-${name}-noglow`)
    await stage(true)
    const adds = []
    rects.forEach((r, i) => {
      const add = on.rings[i].map((v, c) => v - off.rings[i][c])
      adds.push(add)
      const [dr, dg, db] = add
      log(`${name}: seat ${r.g.owner}'s ring gains R ${dr.toFixed(2)} G ${dg.toFixed(2)} B ${db.toFixed(2)} with its glow`)
      const red = r.g.owner === 0
      const own = red ? dr : Math.min(dg, db)
      const other = red ? Math.max(dg, db) : dr
      if (!(own >= LIFT_MIN[name])) problems.push(`${name}: seat ${r.g.owner}'s glow lifts its own colour only ${own.toFixed(2)} (min ${LIFT_MIN[name]}) — not seen`)
      if (!(own > other)) problems.push(`${name}: seat ${r.g.owner}'s glow is not its colour (R ${dr.toFixed(2)} G ${dg.toFixed(2)} B ${db.toFixed(2)})`)
    })
    const hue = (a) => Math.atan2(Math.sqrt(3) * (a[1] - a[2]), 2 * a[0] - a[1] - a[2])
    const apart = Math.abs(hue(adds[0]) - hue(adds[1]))
    log(`${name}: the two glows' hues ${(apart * 180 / Math.PI).toFixed(0)}° apart`)
    if (!(apart > Math.PI / 3)) problems.push(`${name}: the two graves glow in near the same hue (${(apart * 180 / Math.PI).toFixed(0)}° apart)`)
    if (on.ctl && off.ctl) {
      const moved = Math.max(...on.ctl.map((v, c) => Math.abs(v - off.ctl[c])))
      log(`${name}: control patch moved ${moved.toFixed(2)} (max ${CONTROL_MAX})`)
      if (!(moved <= CONTROL_MAX)) problems.push(`${name}: the control patch moved ${moved.toFixed(2)}`)
    } else problems.push(`${name}: the control patch is off camera`)
    await page.evaluate(() => window.__game.freeze(false))
  }

  await page.evaluate((t) => window.__game.setTime(t), NIGHT_T)
  const dark = (await page.evaluate(() => window.__game.debug())).darkness
  if (!(dark > 0.5)) problems.push(`setTime(${NIGHT_T}) is not night: darkness ${dark}`)
  await leg('night')
  let noonT = null
  for (const t of [0, 10, 20, 30, 40, 50, 60]) {
    await page.evaluate((v) => window.__game.setTime(v), t)
    if ((await page.evaluate(() => window.__game.debug())).darkness === 0) {
      noonT = t
      break
    }
  }
  if (noonT === null) problems.push('no setTime in 0..60 s gives darkness 0 — no noon to stage')
  else await leg('noon')
  await page.evaluate(() => window.__game.stageFurniture(null))
  await page.evaluate(() => window.__game.watch(null))
  await page.evaluate(() => window.__game.setTime(null))
  if (problems.length) throw new Error(`graves: ${problems.join('; ')}`)
}
