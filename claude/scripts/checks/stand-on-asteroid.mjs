#!/usr/bin/env node
/**
 * T22.19 (`M22-OWNER-ROUND-2` R107) — **characters stand on asteroids**, on rendered pixels.
 *
 *   node scripts/checks/stand-on-asteroid.mjs
 *
 * Two humans in a private Space room on a `DEV_PROBE=1` server — the host (ana) on WebGL,
 * the guest (bo) on the **Canvas** renderer (`?renderer=canvas`), so ana is a local body on
 * one path and a remote body on the other. `debug_place` (`World::dev_relocate`) puts ana
 * at rest in a rock's band; the field then carries her onto the rock, and:
 *
 * 0. **the name tag** (T22.19B F6): each page draws the other player's name above them —
 *    the frozen frame against the same instant with the tags hidden, a patch beside the
 *    tag as the control; ana's WebGL view of bo and bo's Canvas view of ana;
 * 1. **the underside** — her figure is drawn **feet-up**: the drawn figure matches the
 *    **reference** — the same instant posed upright *with the aim in the figure's own frame*
 *    (`aim − tilt`, so it faces the way the drawn figure faces: T22.19B F1 — the screen
 *    aim turned 180° faces away, and a vertically flipped figure matched that reference
 *    1.00) — **turned by the drawn tilt about the drawn feet** (`feetOffset`, T22.19B F3);
 *    it does not match the upright pose unturned (`straight`), and **it faces the right
 *    way**: the reference posed facing away (`aim − tilt + π`) scores clearly less. The
 *    figure's pixels are the frame minus the same instant with the actors hidden (§C2's
 *    control frame). Both pages: ana's own (local, WebGL) and bo's view of her (remote, Canvas);
 * 2. **the top** (the control): upright — matches the upright pose unturned;
 * 3. **the ease** (T22.19B F2): moved a short step (under `STAND_SNAP_PX`, so it is not a
 *    relocation, T22.19B F5) off the underside into open space where nothing pulls, the
 *    tilt eases back — several drawn frames between feet-up and upright — and **one
 *    in-between frame is photographed** (|tilt| between π/3 and 2π/3, frozen on the frame
 *    it was drawn) and matched against the reference turned by *that* tilt, better than
 *    against upright or feet-up — so a figure drawn snapped to 0 or π while the scene's
 *    number eases is red; then it ends upright and the frame matches the upright pose;
 * 4. **the aim stays in screen space** (R107: controls stay screen-relative): feet-up on
 *    the underside, the mouse to her right on screen gives an aim of ~0;
 * 5. **the side of a rock** (T22.19B F2): placed beside a rock's flank the pull is along ±x,
 *    and the figure is drawn a quarter turn — matched like 1 at the drawn tilt (≈ ±π/2),
 *    facing checked, not matching the upright pose; and **its feet stand on the flank, not in
 *    it** (T22.19B F3): the figure pixels over solid rock (each asked of the core's mask) are no
 *    more than `SINK_RATIO` × what the same pivot sinks on the top and underside (the boots'
 *    designed overshoot) — the T22.19 centre pivot sank the side pose four times that.
 *
 * The pull the tilt follows is Rust's (`Core.standPullAt`, the wells alone since T22.19B);
 * nothing here sums a field. Screenshots: `stand-name-{webgl,canvas}.png`,
 * `stand-underside{,-remote-canvas}.png`, `stand-ease.png`, `stand-side.png`,
 * `stand-top.png`, `stand-free.png`.
 */
import { startStack, freePort, tally, shotsDir, drawnFrames, privateMatch } from './harness.mjs'
import { deadlineMs } from '../lib/deadline.mjs'
import { photo, toScreen, comparePhotos } from './pixels.mjs'
import { join } from 'node:path'

const { fail, ok, finish } = tally('stand-on-asteroid')
const frames = (page, n) => drawnFrames(page, n)
const WARMUP_S = 3
const ROUND_S = 120
/** A tilt within this of its goal counts as there, rad. */
const TILT_EPS = 0.06
/** Figure pixels: a channel this far from the actors-hidden frame. */
const FIG_DIFF = 30
/** Two figure pixels match if every channel is within this. */
const MATCH_DIFF = 60
/** A matched pose scores at least this; the other orientation this much less. */
const MATCH_MIN = 0.6
const MATCH_MARGIN = 0.2
/**
 * T22.19B F1: the reference facing the drawn figure's way must beat the one facing away by
 * this. Measured at T22.19B's review: the real drawing scored 0.77 against the away-facing
 * pose and a vertically flipped figure 1.00 — so a figure facing wrong loses by ~0.2.
 */
const FACING_MARGIN = 0.1
/** Frames the free float must spend between feet-up and upright to count as eased (see arm 3). */
const EASE_FRAMES_MIN = 3
/** Air between the rock's outline and the placed body, px — inside the band, above the lumps. */
const GAP = 3
/** `standTilt-math.ts::STAND_SNAP_PX` — a move under it is travel, not a relocation (arm 3). */
const STAND_SNAP_PX = 64
/** Name tag: pixels that must change when the tags are hidden; the control patch none. */
const NAME_MIN_PX = 6
/**
 * T22.19B F3: the side pose may sink into the rock at most this multiple of what the same
 * pivot sinks on the rock's top and underside (the boots' designed overshoot below the feet:
 * measured 290 / 141 px there). The T22.19 centre pivot sank the side pose 588 px against a
 * correct 141 (`gate-t2219b-plantF3.txt`).
 */
const SINK_RATIO = 1.25

const wrap = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI))

/**
 * Score the drawn figure `a` against references. Each reference is an image, the tilt it is
 * turned by, and the pivots: `pa` the drawn feet and `pu` the reference's feet (photo px).
 * A drawn figure pixel X is looked up at `pu + R(−θ)(X − pa)` in the reference.
 */
async function orientation(page, a, h, refs) {
  return page.evaluate(
    async ([A, H, R, figDiff, matchDiff]) => {
      const load = async (src) => {
        const img = new Image()
        img.src = `data:image/png;base64,${src}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return { d: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height }
      }
      const a = await load(A)
      const h = await load(H)
      const refs = []
      for (const r of R) refs.push({ ...r, im: await load(r.img) })
      const px = (im, x, y) => {
        const i = (y * im.w + x) * 4
        return [im.d[i], im.d[i + 1], im.d[i + 2]]
      }
      const far = (p, q, t) => p.some((v, i) => Math.abs(v - q[i]) > t)
      const fig = (im, x, y) => x >= 0 && y >= 0 && x < im.w && y < im.h && far(px(im, x, y), px(h, x, y), figDiff)
      let n = 0
      const hits = refs.map(() => 0)
      const figPx = []
      for (let y = 0; y < a.h; y++) {
        for (let x = 0; x < a.w; x++) {
          if (!fig(a, x, y)) continue
          n++
          figPx.push([x, y])
          refs.forEach((r, k) => {
            const c = Math.cos(-r.theta)
            const s = Math.sin(-r.theta)
            const dx = x + 0.5 - r.pa.x
            const dy = y + 0.5 - r.pa.y
            const qx = Math.floor(r.pu.x + c * dx - s * dy)
            const qy = Math.floor(r.pu.y + s * dx + c * dy)
            for (let oy = -1; oy <= 1; oy++)
              for (let ox = -1; ox <= 1; ox++)
                if (fig(r.im, qx + ox, qy + oy) && !far(px(a, x, y), px(r.im, qx + ox, qy + oy), matchDiff)) {
                  hits[k]++
                  return
                }
          })
        }
      }
      return { figure: n, scores: hits.map((v) => (n ? v / n : 0)), figPx }
    },
    [a, h, refs.map((r) => ({ img: r.img, theta: r.theta, pa: r.pa, pu: r.pu })), FIG_DIFF, MATCH_DIFF],
  )
}

/**
 * Photograph `who`'s figure frozen: as drawn, and posed upright three ways — with the
 * screen aim (`straight`), with the aim in the drawn figure's frame (`facing`, the T22.19B
 * F1 reference) and facing away from it (`away`) — and with the actors hidden. `info()` is
 * the view's last draw `{ tilt, aim, at, feet }` (world px); `pose(t, aim)` redraws the same
 * instant at tilt `t`. Name tags are hidden throughout (the tag stays upright, so it is not
 * part of the figure that turns). Leaves the page frozen when `keepFrozen`.
 */
async function shoot(page, info, pose, k, name, { keepFrozen = false } = {}) {
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await page.evaluate(() => window.__game.setNamesVisible(false))
    await frames(page, 2)
    const d = await info()
    const s = await toScreen(page, d.at.x, d.at.y)
    const half = Math.ceil(k.PLAYER_H * s.scale)
    const rect = { x: Math.round(s.x - half), y: Math.round(s.y - half), w: 2 * half + 1, h: 2 * half + 1 }
    const local = async (p) => {
      const q = await toScreen(page, p.x, p.y)
      return { x: q.x - rect.x, y: q.y - rect.y }
    }
    const pa = await local(d.feet)
    const a = await photo(page, rect)
    await page.screenshot({ path: join(shotsDir, `${name}.png`) })
    const shots = {}
    for (const [key, aim] of [['straight', d.aim], ['facing', d.aim - d.tilt], ['away', d.aim - d.tilt + Math.PI]]) {
      await pose(0, aim)
      await frames(page, 1)
      shots[key] = await photo(page, rect)
    }
    const pu = await local((await info()).feet)
    await page.evaluate(() => window.__game.setActorsVisible(false))
    await frames(page, 1)
    const h = await photo(page, rect)
    await page.evaluate(() => window.__game.setActorsVisible(true))
    await pose(d.tilt, d.aim)
    const r = await orientation(page, a, h, [
      { img: shots.straight, theta: 0, pa, pu: pa },
      { img: shots.facing, theta: d.tilt, pa, pu },
      { img: shots.away, theta: d.tilt, pa, pu },
      { img: shots.facing, theta: 0, pa: pu, pu },
      { img: shots.facing, theta: Math.PI, pa: await local({ x: d.at.x, y: d.at.y - k.PLAYER_H / 2 }), pu },
    ])
    const [straight, turned, away, up, flip] = r.scores
    // T22.19B F3: figure pixels drawn over solid rock — the feet sunk into it. Each figure
    // pixel's world point asked of the core's mask.
    const sunk = await page.evaluate(
      ([px, rx, ry]) => {
        const raw = window.__game.debug().worldView
        const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
        const b = document.querySelector('canvas').getBoundingClientRect()
        let n = 0
        for (const [x, y] of px) {
          const wx = v.x + ((rx + x + 0.5 - b.left) / b.width) * v.w
          const wy = v.y + ((ry + y + 0.5 - b.top) / b.height) * v.h
          if (window.__game.core.solidAt(Math.floor(wx), Math.floor(wy))) n++
        }
        return n
      },
      [r.figPx, rect.x, rect.y],
    )
    return { figure: r.figure, straight, turned, away, up, flip, sunk, tilt: d.tilt }
  } finally {
    await page.evaluate(() => window.__game.setNamesVisible(true))
    if (!keepFrozen) await page.evaluate(() => window.__game.freeze(false))
  }
}

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v))
const line = (label, r) =>
  `${label}: tilt ${r.tilt?.toFixed(3)}, figure ${r.figure} px (${r.sunk} over rock) — against the upright pose: straight ${f2(r.straight)}, ` +
  `turned by the tilt ${f2(r.turned)} (facing away ${f2(r.away)})`

/** `want`: 'upright' (straight wins), or 'turned' (the tilt's turn wins, facing right). */
const verdict = (label, r, want) => {
  const l = line(label, r)
  if (r.figure < 20) return fail(`${l} — too little figure to judge`)
  if (want === 'upright') {
    if (Math.abs(r.tilt) > TILT_EPS) return fail(`${l} — expected upright`)
    if (r.straight < MATCH_MIN) return fail(`${l} — expected the upright pose to match`)
    // Upright, the turned reference *is* the straight one; the control is the pose turned π.
    if (r.straight - r.flip < MATCH_MARGIN) return fail(`${l}, feet-up ${f2(r.flip)} — upright does not win`)
    return ok(`${l}, feet-up ${f2(r.flip)} — drawn upright`)
  }
  if (r.turned < MATCH_MIN || r.turned - r.straight < MATCH_MARGIN) return fail(`${l} — expected turned by the tilt`)
  if (r.turned - r.away < FACING_MARGIN) return fail(`${l} — faces the wrong way (the reference facing away matches as well)`)
  return ok(`${l} — drawn turned, facing the aim`)
}

/**
 * Where to put a body in `rock`'s band on side `dir` (`[0, 1]` under, `[0, −1]` over,
 * `[±1, 0]` beside), straight in line with its centre; the pull there must point back at
 * the rock along that line.
 */
async function spotBy(page, rock, dir, k) {
  return page.evaluate(
    ([a, d, H, W, gap]) => {
      const core = window.__game.core
      const [dx, dy] = d
      // The body's half-extent across the line and along it.
      const across = dx ? H / 2 : W / 2
      const along = dx ? W / 2 : H / 2
      let edge = null
      for (let t = 0; t <= a.r + 2; t++) {
        for (let u = -Math.ceil(across); u <= Math.ceil(across); u++) {
          const x = a.x + dx * t + (dx ? 0 : u)
          const y = a.y + dy * t + (dx ? u : 0)
          if (core.solidAt(x, y)) edge = t
        }
      }
      if (edge === null) return null
      const t = edge + 1 + gap + along
      const at = { x: a.x + dx * t, y: a.y + dy * t }
      for (let y = Math.floor(at.y - H / 2) - 1; y <= Math.ceil(at.y + H / 2) + 1; y++)
        for (let x = Math.floor(at.x - W / 2) - 1; x <= Math.ceil(at.x + W / 2) + 1; x++) if (core.solidAt(x, y)) return null
      if (!core.spaceInside(at.x, at.y)) return null
      const f = core.standPullAt(at.x, at.y, 0)
      // Pulled back toward the rock along the line.
      const back = -(f[0] * dx + f[1] * dy)
      const off = Math.abs(f[0] * dy - f[1] * dx)
      if (!(back > 0 && off < 1e-3 * back)) return null
      return at
    },
    [rock, dir, k.PLAYER_H, k.PLAYER_W, GAP],
  )
}

async function place(page, at) {
  await page.evaluate(([x, y]) => window.__game.debugPlace(x, y), [at.x, at.y])
  await page.waitForFunction(() => window.__game.debug().stand.lastPlace !== null, null, { timeout: deadlineMs(10, 'debug_place') })
  const got = (await page.evaluate(() => window.__game.debug())).stand.lastPlace
  if (!got) throw new Error(`debug_place answered null for ${JSON.stringify(at)}`)
}

/** Wait until ana is at rest on the rock and her drawn tilt has reached `goal`. */
async function settle(page, goal, why) {
  const said = (d) => JSON.stringify({ stand: { ...d.stand, remotes: undefined }, player: d.player && { x: d.player.x, y: d.player.y, vx: d.player.vx, vy: d.player.vy } })
  await page.waitForFunction(
    ([g, eps]) => {
      const d = window.__game.debug()
      const t = d.stand.drawn
      const w = t - g - 2 * Math.PI * Math.floor((t - g + Math.PI) / (2 * Math.PI))
      // At rest against the rock — not `grounded`, which is a floor under the feet.
      return d.player && Math.hypot(d.player.vx, d.player.vy) < 1 && Math.abs(w) < eps
    },
    [goal, TILT_EPS],
    { timeout: deadlineMs(10, why), polling: 'raf' },
  ).catch(async (e) => {
    throw new Error(`${why}: ${String(e).split('\n')[0]} — last seen ${said(await page.evaluate(() => window.__game.debug()))}`)
  })
}

/**
 * T22.19B F6: the name tag of remote `id` on `page`, on pixels — the frozen frame against the
 * same instant with every tag hidden, over the tag's patch and over a control patch of the
 * same size beside it.
 */
async function nameArm(page, id, want, label, shot) {
  await page.waitForFunction((i) => window.__game.debug().stand.remotes.some((q) => q.id === i && q.name?.visible), id, {
    timeout: deadlineMs(10, `${label}: the remote drawn`),
    polling: 'raf',
  })
  const at = (await page.evaluate((i) => window.__game.debug().stand.remotes.find((q) => q.id === i), id)).at
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [at.x, at.y])
  await frames(page, 6)
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await frames(page, 2)
    const tag = (await page.evaluate((i) => window.__game.debug().stand.remotes.find((q) => q.id === i), id)).name
    const s = await toScreen(page, tag.x, tag.y)
    const w = Math.ceil(24 * s.scale)
    const h = Math.ceil(12 * s.scale)
    const rect = { x: Math.round(s.x - w / 2), y: Math.round(s.y - h), w, h }
    // The control: the same patch shifted a body-and-a-half aside, where no tag is.
    const ctl = { ...rect, x: rect.x + Math.ceil(48 * s.scale) }
    const on = [await photo(page, rect), await photo(page, ctl)]
    await page.screenshot({ path: join(shotsDir, `${shot}.png`) })
    const hid = await page.evaluate(() => window.__game.setNamesVisible(false))
    await frames(page, 1)
    const off = [await photo(page, rect), await photo(page, ctl)]
    await page.evaluate(() => window.__game.setNamesVisible(true))
    const tagPx = Math.round((await comparePhotos(page, on[0], off[0])).fraction * rect.w * rect.h)
    const ctlPx = Math.round((await comparePhotos(page, on[1], off[1])).fraction * ctl.w * ctl.h)
    const l = `${label}: the tag reads "${tag.text}" (want "${want}"), ${tagPx} px of it drawn above the body, control patch ${ctlPx} px (tags hidden: ${hid})`
    if (tag.text !== want) fail(`${l} — the wrong name`)
    else if (tagPx < NAME_MIN_PX) fail(`${l} — no name drawn`)
    else if (ctlPx > 0) fail(`${l} — the control moved`)
    else ok(l)
  } finally {
    await page.evaluate(() => window.__game.freeze(false))
    await page.evaluate(() => window.__game.watch(null))
  }
}

const stack = await startStack({
  port: await freePort(),
  label: 'stand-on-asteroid',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', DEV_PROBE: '1', DEV_WARMUP_SECONDS: String(WARMUP_S), ROUND_SECONDS: String(ROUND_S) },
})
try {
  const [host, guest] = await privateMatch(stack, ['ana', 'bo'], 'Space', { guestQuery: 'renderer=canvas' })
  const page = host.page
  const g = guest.page
  const k = await page.evaluate(() => window.__game.constants())
  const dbg = () => page.evaluate(() => window.__game.debug())
  await page.waitForFunction(() => window.__game.debug().phase === 'playing', null, { timeout: deadlineMs(WARMUP_S + 30, 'the round to start') })

  // --- 0. the name tags (T22.19B F6), both paths ----------------------------------------
  await nameArm(page, guest.id, 'bo', 'name tag (ana sees bo, WebGL)', 'stand-name-webgl')
  await nameArm(g, host.id, 'ana', 'name tag (bo sees ana, Canvas)', 'stand-name-canvas')

  // A rock with room under it, over it and beside it, in line with its centre.
  const rocks = await page.evaluate(() => window.__game.core.meta.asteroids.map((a) => ({ x: a.x, y: a.y, r: a.r })))
  let under = null
  let top = null
  let side = null
  for (const a of [...rocks].sort((p, q) => q.r - p.r)) {
    const u = await spotBy(page, a, [0, 1], k)
    const t = await spotBy(page, a, [0, -1], k)
    const sd = (await spotBy(page, a, [1, 0], k)) ?? (await spotBy(page, a, [-1, 0], k))
    if (u && t && sd) {
      under = u
      top = t
      side = sd
      break
    }
  }
  if (!under) throw new Error(`no rock of ${rocks.length} has clear air in its band under, over and beside it`)

  const localPose = (t, aim) => page.evaluate(([v, a]) => window.__game.poseLocalTilt(v, a), [t, aim])
  const localInfo = async () => {
    const s = (await dbg()).stand
    return { tilt: s.drawn, aim: s.aim, at: s.at, feet: s.feet }
  }

  // --- 1. the underside: feet-up, local (WebGL) and remote (Canvas) ------------------
  await place(page, under)
  await settle(page, Math.PI, 'ana standing feet-up on the underside')
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [under.x, under.y])
  await frames(page, 6)
  const underR = await shoot(page, localInfo, localPose, k, 'stand-underside')
  verdict('underside (local, WebGL)', underR, 'turned')

  // The remote: bo's view of ana, on the Canvas renderer.
  await g.waitForFunction(
    ([id, eps]) => {
      const r = window.__game.debug().stand.remotes.find((q) => q.id === id)
      return r && Math.PI - Math.abs(r.drawn) < eps
    },
    [host.id, TILT_EPS],
    { timeout: deadlineMs(10, "bo's view of ana turning feet-up"), polling: 'raf' },
  ).catch(async (e) => {
    const seen = await g.evaluate(() => window.__game.debug().stand.remotes)
    throw new Error(`bo's view of ana never drew her feet-up: ${String(e).split('\n')[0]} — remotes ${JSON.stringify(seen)}`)
  })
  const kind = await g.evaluate(() => {
    const cv = document.querySelector('canvas')
    return { twoD: !!cv?.getContext('2d'), webgl: !!(cv?.getContext('webgl') || cv?.getContext('webgl2')) }
  })
  if (!kind.twoD) fail(`bo's page did not get the Canvas renderer: ${JSON.stringify(kind)}`)
  const remoteInfo = async () => {
    const r = (await g.evaluate(() => window.__game.debug())).stand.remotes.find((q) => q.id === host.id)
    return { tilt: r.drawn, aim: r.aim, at: r.at, feet: r.feet }
  }
  await g.evaluate(([x, y]) => window.__game.watch(x, y), [under.x, under.y])
  await frames(g, 6)
  const remotePose = (t, aim) => g.evaluate(([id, v, a]) => window.__game.poseRemoteTilt(id, v, a), [host.id, t, aim])
  verdict('underside (remote, Canvas)', await shoot(g, remoteInfo, remotePose, k, 'stand-underside-remote-canvas'), 'turned')

  // --- 4. the aim stays in screen space, feet-up ----------------------------------------
  {
    const at = (await localInfo()).at
    await page.evaluate(() => window.__game.watch(null))
    await frames(page, 4)
    const s2 = await toScreen(page, at.x, at.y)
    await page.mouse.move(s2.x + 120, s2.y)
    await frames(page, 6)
    const d = await dbg()
    const ch = d.crosshair
    const a = Math.atan2(ch.y - d.stand.at.y, ch.x - d.stand.at.x)
    if (!(Math.PI - Math.abs(d.stand.drawn) < TILT_EPS)) fail(`aim: ana is no longer feet-up (tilt ${d.stand.drawn}) — the arm judges nothing`)
    else if (Math.abs(a) > 0.1) fail(`aim: feet-up with the mouse to her right on screen, the aim is ${a.toFixed(3)} rad — mirrored by the tilt`)
    else ok(`aim: feet-up (tilt ${d.stand.drawn.toFixed(3)}), the mouse to her right aims ${a.toFixed(3)} rad — screen space`)
  }

  // --- 3. the ease: a short step into open space, one in-between frame photographed -----
  {
    // Open space a short step below where she rests — under `STAND_SNAP_PX`, so the step
    // is travel and the tilt turns (a longer one is a relocation and snaps, T22.19B F5).
    const rest = (await localInfo()).at
    const near = await page.evaluate(
      ([u, H, W, max]) => {
        const core = window.__game.core
        for (let d = 8; d <= max; d += 2) {
          const at = { x: u.x, y: u.y + d }
          if (!core.spaceInside(at.x, at.y)) continue
          const f = core.standPullAt(at.x, at.y, 0)
          if (f[0] !== 0 || f[1] !== 0) continue
          let clear = true
          for (let y = Math.floor(at.y - H / 2) - 2; y <= at.y + H / 2 + 2 && clear; y++)
            for (let x = Math.floor(at.x - W / 2) - 2; x <= at.x + W / 2 + 2 && clear; x++) if (core.solidAt(x, y)) clear = false
          if (clear) return { at, d }
        }
        return null
      },
      [rest, k.PLAYER_H, k.PLAYER_W, STAND_SNAP_PX - 8],
    )
    if (!near) throw new Error(`no pull-free spot within ${STAND_SNAP_PX - 8} px below the underside`)
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [near.at.x, near.at.y])
    await frames(page, 4)
    // Every drawn frame's tilt, until the first in-between one (|tilt| in [π/3, 2π/3]),
    // on which the page freezes itself — in the frame's own callback, so the picture is
    // the tilt read. "Eased, not snapped" is judged by frames between feet-up and upright
    // (a frame of `MAX_FRAME_DT` still leaves three in between; a snap leaves none).
    const record = (n, stopMid) =>
      page.evaluate(
        ([m, stop]) =>
          new Promise((resolve) => {
            const out = []
            const tick = () => {
              const t = Math.abs(window.__game.debug().stand.drawn)
              out.push(t)
              if (stop && t >= Math.PI / 3 && t <= (2 * Math.PI) / 3) {
                window.__game.freeze(true)
                resolve({ out, mid: true })
              } else if (out.length >= m) resolve({ out, mid: false })
              else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          }),
        [n, stopMid],
      )
    const first = record(120, true)
    await place(page, near.at)
    const a1 = await first
    let mid = null
    if (a1.mid) mid = await shoot(page, localInfo, localPose, k, 'stand-ease', { keepFrozen: false })
    const a2 = await record(120, false)
    const got = [...a1.out, ...a2.out]
    const start = got.findIndex((v) => v < Math.PI - TILT_EPS)
    const between = got.filter((v) => v > TILT_EPS && v < Math.PI - TILT_EPS)
    const pull = (await dbg()).stand.pull
    if (!pull || pull[0] !== 0 || pull[1] !== 0) fail(`ease: something pulls there: ${JSON.stringify(pull)}`)
    else if (start < 0) fail(`ease: the tilt never left feet-up in ${got.length} frames`)
    else if (between.length < EASE_FRAMES_MIN) fail(`ease: snapped upright — only ${between.length} frames between feet-up and upright`)
    else ok(`ease: a ${near.d} px step off the rock — ${between.length} frames between feet-up and upright`)
    if (!mid) fail(`ease: no frame drawn with |tilt| between π/3 and 2π/3 — seen ${got.slice(0, 40).map((v) => v.toFixed(2)).join(' ')}`)
    else {
      const l = line('ease (an in-between frame, local, WebGL)', mid) + `, upright ${f2(mid.up)}, feet-up ${f2(mid.flip)}`
      if (mid.figure < 20) fail(`${l} — too little figure to judge`)
      else if (mid.turned < MATCH_MIN || mid.turned - Math.max(mid.up, mid.flip, mid.straight) < MATCH_MARGIN)
        fail(`${l} — the frame is not drawn at the tilt it reports`)
      else ok(`${l} — drawn at the in-between tilt`)
    }
    await page.waitForFunction((eps) => Math.abs(window.__game.debug().stand.drawn) < eps, TILT_EPS, { timeout: deadlineMs(5, 'upright in free space'), polling: 'raf' })
    await frames(page, 6)
    verdict('free float (local, WebGL)', await shoot(page, localInfo, localPose, k, 'stand-free'), 'upright')
  }

  // --- 5. the side of a rock: a quarter turn ---------------------------------------------
  let sideR = null
  {
    await place(page, side)
    // The pull at the placed spot decides which quarter: feet along it.
    const f = await page.evaluate(([x, y]) => Array.from(window.__game.core.standPullAt(x, y, 0)), [side.x, side.y])
    const want = Math.atan2(-f[0], f[1])
    await settle(page, want, `ana standing on the side of the rock (tilt ${want.toFixed(3)})`)
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [side.x, side.y])
    await frames(page, 6)
    sideR = await shoot(page, localInfo, localPose, k, 'stand-side')
    const r = sideR
    if (Math.abs(Math.abs(wrap(r.tilt)) - Math.PI / 2) > 0.3) fail(`side: tilt ${r.tilt} is not a quarter turn — the arm judges nothing`)
    verdict('side (local, WebGL)', r, 'turned')
  }

  // --- 2. the top: upright ------------------------------------------------------------
  await place(page, top)
  await settle(page, 0, 'ana standing on the top')
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [top.x, top.y])
  await frames(page, 6)
  const topR = await shoot(page, localInfo, localPose, k, 'stand-top')
  verdict('top (local, WebGL)', topR, 'upright')

  // --- 5b. the side's feet stand on the flank, not in it (T22.19B F3) -----------------
  {
    const base = Math.max(topR.sunk, underR.sunk)
    const l = `side: ${sideR.sunk} figure px over rock, against ${topR.sunk} on the top and ${underR.sunk} on the underside (the same pivot's boots)`
    if (base === 0) fail(`${l} — the control sank nothing, so the arm judges nothing`)
    else if (sideR.sunk > SINK_RATIO * base) fail(`${l} — the feet sink into the flank`)
    else ok(`${l} — standing on the flank`)
  }

  for (const c of [host, guest]) if (c.errors.length) fail(`${c.name}: page errors: ${c.errors.join(' | ')}`)
} catch (e) {
  fail(`${e?.stack ?? e}`)
} finally {
  await stack.close()
}

await finish()
