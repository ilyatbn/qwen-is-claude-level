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
 * 1. **the underside** — her figure is drawn **feet-up**: on the frozen frame, the drawn
 *    figure matches the same instant posed upright (`poseLocalTilt(0)`) **rotated 180°**
 *    about her centre, and does not match it unrotated. The figure's pixels are the
 *    frame minus the same instant with the actors hidden (§C2's control frame). Both
 *    pages: ana's own (local, WebGL) and bo's view of her (remote, Canvas);
 * 2. **the top** (the control): upright — matches the upright pose unrotated, not rotated;
 * 3. **free float** (the other control): moved from the underside to open space where
 *    nothing pulls, the tilt **eases** back (not snapped: several drawn frames between
 *    feet-up and upright) and ends upright, and the frame matches the upright pose;
 * 4. **the aim stays in screen space** (R107: controls stay screen-relative): feet-up on
 *    the underside, the mouse to her right on screen gives an aim of ~0 — the crosshair
 *    right of her, not mirrored.
 *
 * The pull the tilt follows is Rust's (`Core.standPullAt` → `env_at`); nothing here sums
 * a field. Screenshots: `stand-underside{,-remote-canvas}.png`, `stand-top.png`, `stand-free.png`.
 */
import { startStack, freePort, tally, shotsDir, drawnFrames, privateMatch } from './harness.mjs'
import { deadlineMs } from '../lib/deadline.mjs'
import { photo, toScreen } from './pixels.mjs'
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
/** Frames the free float must spend between feet-up and upright to count as eased (see arm 3). */
const EASE_FRAMES_MIN = 3
/** Air between the rock's outline and the placed body, px — inside the band, above the lumps. */
const GAP = 3

/** Score the drawn figure against the upright pose, straight and turned 180° about `c`. */
async function orientation(page, c, a, u, h) {
  return page.evaluate(
    async ([A, U, H, cx, cy, figDiff, matchDiff]) => {
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
      const [a, u, h] = [await load(A), await load(U), await load(H)]
      const px = (im, x, y) => {
        const i = (y * im.w + x) * 4
        return [im.d[i], im.d[i + 1], im.d[i + 2]]
      }
      const far = (p, q, t) => p.some((v, i) => Math.abs(v - q[i]) > t)
      const fig = (im, x, y) => x >= 0 && y >= 0 && x < im.w && y < im.h && far(px(im, x, y), px(h, x, y), figDiff)
      let n = 0
      let straight = 0
      let turned = 0
      for (let y = 0; y < a.h; y++) {
        for (let x = 0; x < a.w; x++) {
          if (!fig(a, x, y)) continue
          n++
          const hit = (qx, qy) => {
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++)
                if (fig(u, qx + dx, qy + dy) && !far(px(a, x, y), px(u, qx + dx, qy + dy), matchDiff)) return true
            return false
          }
          if (hit(x, y)) straight++
          if (hit(Math.round(2 * cx - x - 1), Math.round(2 * cy - y - 1))) turned++
        }
      }
      return { figure: n, straight: n ? straight / n : 0, turned: n ? turned / n : 0 }
    },
    [a, u, h, c.x, c.y, FIG_DIFF, MATCH_DIFF],
  )
}

/**
 * Photograph `who`'s figure frozen: as drawn, posed upright, and with the actors hidden.
 * `pose(t)` redraws it at tilt `t`; `centre()` is its drawn centre (world px).
 */
async function shoot(page, centre, pose, k, name) {
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await frames(page, 2)
    const at = await centre()
    const s = await toScreen(page, at.x, at.y)
    const half = Math.ceil((k.PLAYER_H / 2) * s.scale)
    const rect = { x: Math.round(s.x - half), y: Math.round(s.y - half), w: 2 * half + 1, h: 2 * half + 1 }
    const c = { x: s.x - rect.x, y: s.y - rect.y }
    const drawn = await pose(null)
    await frames(page, 1)
    const a = await photo(page, rect)
    await page.screenshot({ path: join(shotsDir, `${name}.png`) })
    await pose(0)
    await frames(page, 1)
    const u = await photo(page, rect)
    await page.evaluate(() => window.__game.setActorsVisible(false))
    await frames(page, 1)
    const h = await photo(page, rect)
    await page.evaluate(() => window.__game.setActorsVisible(true))
    await pose(drawn)
    const r = await orientation(page, c, a, u, h)
    return { ...r, tilt: drawn }
  } finally {
    await page.evaluate(() => window.__game.freeze(false))
  }
}

/** Where to put a body in `rock`'s band: under it (`dir` +1) or over it (−1), straight in line. */
async function spotBy(page, rock, dir, k) {
  return page.evaluate(
    ([a, d, H, W, gap]) => {
      const core = window.__game.core
      // The rock's extent along the column the body would stand in, from its pixels.
      let edge = null
      for (let t = 0; t <= a.r + 2; t++) {
        const y = a.y + d * t
        for (let x = Math.floor(a.x - W / 2); x <= Math.ceil(a.x + W / 2); x++) if (core.solidAt(x, y)) edge = y
      }
      if (edge === null) return null
      const at = { x: a.x, y: edge + d * (1 + gap + H / 2) }
      for (let y = Math.floor(at.y - H / 2) - 1; y <= Math.ceil(at.y + H / 2) + 1; y++)
        for (let x = Math.floor(at.x - W / 2) - 1; x <= Math.ceil(at.x + W / 2) + 1; x++) if (core.solidAt(x, y)) return null
      if (!core.spaceInside(at.x, at.y)) return null
      const f = core.standPullAt(at.x, at.y, 0)
      // Pulled toward the rock along the column: the underside's is up, the top's down.
      if (!(Math.sign(f[1]) === -d && Math.abs(f[0]) < 1e-3)) return null
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

/** Wait until ana is at rest on the rock and her drawn tilt has reached `goal` (|tilt| for π). */
async function settle(page, goal, why) {
  const said = (d) => JSON.stringify({ stand: d.stand, player: d.player && { x: d.player.x, y: d.player.y, vx: d.player.vx, vy: d.player.vy, grounded: d.player.grounded } })
  await page.waitForFunction(
    ([g, eps]) => {
      const d = window.__game.debug()
      const t = d.stand.drawn
      const near = g === Math.PI ? Math.PI - Math.abs(t) < eps : Math.abs(t - g) < eps
      // At rest against the rock — not `grounded`, which is a floor under the feet: on
      // the underside the rock is over the body's head.
      return d.player && Math.hypot(d.player.vx, d.player.vy) < 1 && near
    },
    [goal, TILT_EPS],
    { timeout: deadlineMs(10, why), polling: 'raf' },
  ).catch(async (e) => {
    throw new Error(`${why}: ${String(e).split('\n')[0]} — last seen ${said(await page.evaluate(() => window.__game.debug()))}`)
  })
}

const verdict = (label, r, want) => {
  const [hi, lo] = want === 'turned' ? [r.turned, r.straight] : [r.straight, r.turned]
  const line = `${label}: tilt ${r.tilt?.toFixed(3)}, figure ${r.figure} px, matches the upright pose straight ${r.straight.toFixed(2)} / turned 180° ${r.turned.toFixed(2)}`
  if (r.figure < 20) fail(`${line} — too little figure to judge`)
  else if (hi < MATCH_MIN || hi - lo < MATCH_MARGIN) fail(`${line} — expected ${want === 'turned' ? 'feet-up' : 'upright'}`)
  else ok(`${line} — drawn ${want === 'turned' ? 'feet-up' : 'upright'}`)
}

const stack = await startStack({
  port: await freePort(),
  label: 'stand-on-asteroid',
  env: { BOT_COUNT: '0', FIXED_SEED: '4242', WEATHER: 'off', DEV_PROBE: '1', DEV_WARMUP_SECONDS: String(WARMUP_S), ROUND_SECONDS: String(ROUND_S) },
})
try {
  const [host, guest] = await privateMatch(stack, ['ana', 'bo'], 'Space', { guestQuery: 'renderer=canvas' })
  const page = host.page
  const k = await page.evaluate(() => window.__game.constants())
  const dbg = () => page.evaluate(() => window.__game.debug())
  await page.waitForFunction(() => window.__game.debug().phase === 'playing', null, { timeout: deadlineMs(WARMUP_S + 30, 'the round to start') })

  // A rock with room under it and over it, in line with its centre.
  const rocks = await page.evaluate(() => window.__game.core.meta.asteroids.map((a) => ({ x: a.x, y: a.y, r: a.r })))
  let under = null
  let top = null
  for (const a of [...rocks].sort((p, q) => q.r - p.r)) {
    const u = await spotBy(page, a, 1, k)
    const t = await spotBy(page, a, -1, k)
    if (u && t) {
      under = u
      top = t
      break
    }
  }
  if (!under) throw new Error(`no rock of ${rocks.length} has clear air in its band both under and over it`)
  // Open space where nothing pulls: searched outward from the rock.
  const free = await page.evaluate(
    ([u, H, W]) => {
      const core = window.__game.core
      for (let d = 3 * H; d < 900; d += 8) {
        for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1]]) {
          const at = { x: u.x + dx * d, y: u.y + dy * d }
          if (!core.spaceInside(at.x, at.y)) continue
          const f = core.standPullAt(at.x, at.y, 0)
          if (f[0] !== 0 || f[1] !== 0) continue
          let clear = true
          for (let y = at.y - 2 * H; y <= at.y + 2 * H && clear; y += 2)
            for (let x = at.x - 2 * W; x <= at.x + 2 * W && clear; x += 2) if (core.solidAt(Math.round(x), Math.round(y))) clear = false
          if (clear) return at
        }
      }
      return null
    },
    [under, k.PLAYER_H, k.PLAYER_W],
  )
  if (!free) throw new Error('no open space found to float in')

  // --- 1. the underside: feet-up, local (WebGL) and remote (Canvas) ------------------
  await place(page, under)
  await settle(page, Math.PI, 'ana standing feet-up on the underside')
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [under.x, under.y])
  await frames(page, 6)
  const localPose = (t) => page.evaluate((v) => (v === null ? window.__game.debug().stand.drawn : window.__game.poseLocalTilt(v)), t)
  const localAt = async () => (await dbg()).stand.at
  verdict('underside (local, WebGL)', await shoot(page, localAt, localPose, k, 'stand-underside'), 'turned')

  // The remote: bo's view of ana, on the Canvas renderer.
  const g = guest.page
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
  const remoteAt = async () => (await g.evaluate(() => window.__game.debug())).stand.remotes.find((q) => q.id === host.id).at
  await g.evaluate(([x, y]) => window.__game.watch(x, y), [under.x, under.y])
  await frames(g, 6)
  const remotePose = (t) =>
    g.evaluate(([id, v]) => (v === null ? window.__game.debug().stand.remotes.find((q) => q.id === id).drawn : window.__game.poseRemoteTilt(id, v)), [host.id, t])
  verdict('underside (remote, Canvas)', await shoot(g, remoteAt, remotePose, k, 'stand-underside-remote-canvas'), 'turned')

  // --- 4. the aim stays in screen space, feet-up ----------------------------------------
  {
    const at = await localAt()
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

  // --- 3. free float: eases back to upright ---------------------------------------------
  {
    // Every drawn frame's tilt, with its time: "eased, not snapped" is judged by how many
    // frames it spends between feet-up and upright, which holds on a slow page too (a
    // frame of `MAX_FRAME_DT` still leaves three in between; a snap leaves none) — not by
    // where it is N frames in, which moved with the box's frame rate (a run under load
    // read 1.53 rad three frames in against a π/2 bound).
    const series = page.evaluate(
      (n) =>
        new Promise((resolve) => {
          const out = []
          const tick = () => {
            out.push([performance.now(), window.__game.debug().stand.drawn])
            if (out.length >= n) resolve(out)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
      120,
    )
    await place(page, free)
    const got = (await series).map(([t, v]) => [t, Math.abs(v)])
    const start = got.findIndex(([, v]) => v < Math.PI - TILT_EPS)
    const between = got.filter(([, v]) => v > TILT_EPS && v < Math.PI - TILT_EPS)
    const upright = got.findIndex(([, v]) => v <= TILT_EPS)
    const took = start >= 0 && upright > start ? (got[upright][0] - got[start - 1 >= 0 ? start - 1 : start][0]) / 1000 : NaN
    const pull = (await dbg()).stand.pull
    if (!pull || pull[0] !== 0 || pull[1] !== 0) fail(`free float: something pulls there: ${JSON.stringify(pull)}`)
    else if (start < 0) fail(`free float: the tilt never left feet-up in ${got.length} frames`)
    else if (between.length < EASE_FRAMES_MIN) fail(`free float: snapped upright — only ${between.length} frames between feet-up and upright`)
    else ok(`free float: eases back — ${between.length} frames between feet-up and upright, ${took.toFixed(2)} s to upright`)
    await page.waitForFunction((eps) => Math.abs(window.__game.debug().stand.drawn) < eps, TILT_EPS, { timeout: deadlineMs(5, 'upright in free space'), polling: 'raf' })
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [free.x, free.y])
    await frames(page, 6)
    verdict('free float (local, WebGL)', await shoot(page, localAt, localPose, k, 'stand-free'), 'straight')
  }

  // --- 2. the top: upright ------------------------------------------------------------
  await place(page, top)
  await settle(page, 0, 'ana standing on the top')
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [top.x, top.y])
  await frames(page, 6)
  verdict('top (local, WebGL)', await shoot(page, localAt, localPose, k, 'stand-top'), 'straight')

  for (const c of [host, guest]) if (c.errors.length) fail(`${c.name}: page errors: ${c.errors.join(' | ')}`)
} catch (e) {
  fail(`${e?.stack ?? e}`)
} finally {
  await stack.close()
}

await finish()
