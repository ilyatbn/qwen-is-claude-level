/**
 * T22.06 — **the space backdrop, on the rendered frame** (`docs/72` §C2), in the sandbox
 * at `?gravity=space` (R22), and the ground sky it replaces as the presence control.
 *
 * **T23.20: rewritten for F3's look** (R13). T22.06's behaviour is kept and measured the same way — seeded, moving on
 * the round's clock, the stars drifting — but the world renderer draws it now (`look/space.ts`): the sun is F3's
 * distant star with its god rays, the earth and the moon are F3's giant stepped arcs, so `debug().spaceSky` reports
 * each arc's **apex** (the top of its limb) and a body is located by its **limb**, not its centroid: the frame with
 * that body hidden is the control, and the top row of the pixels that change, over the columns at the apex, must sit
 * on the reported apex (the sun keeps its centroid). The night-side shades and the moon's going behind the earth are
 * retired with the Phaser planets (the moon's arc is composited in front); `space-sky-canvas` with the Canvas path.
 *
 * The owner: *"there's no day/light in space but the sun and moon and the earth and
 * stars can be the background and should move. there are no clouds or fog or anything
 * like that."* So, on one page, one camera, one frozen round clock at a time:
 *
 * 1. **Each body is drawn where it says it is.** For the sun, the earth and the moon
 *    separately: the frame with that body hidden (`setSpaceBodiesVisible(false, name)`)
 *    is its control frame, the pixels that differ are that body and no other, and their
 *    centroid (the sun) or limb (an arc, T23.20) must sit on the screen position `debug()` reports.
 * 2. **They move across a round.** The same measurement `DT` round-seconds later: each
 *    body's *pixel* centroid moved, by about what `debug()` says it moved. **The camera
 *    did not do it**: the camera's view is asserted identical, and a patch of asteroid clear
 *    of the player — terrain, drawn over the sky — is the control region that
 *    must not change (it would, if the camera had moved or the world had darkened).
 * 3. **Stars, and they drift.** Point lights on the dark counted in the all-bodies-hidden
 *    frame; at `DT` later few of them are where they were, while a second photograph of
 *    the same moment is the control that they are not simply flickering.
 * 4. **Seeded.** Re-seeding the sky alone (`setSkySeed`) moves the stars and bodies; the
 *    first seed again gives the first frame back.
 * 5. **Absences, each beside its presence.** In space: space's sky drawn, not the ground's (T23.20:
 *    the world renderer's `info().spaceSky`; the ridge band, clouds and ambient rain this used to
 *    assert absent are retired), darkness 0 at the ground's night, and the frame no darker at
 *    `T0 + DT` (the ground's night) than at `T0`. Then the **same page regenerated standard**:
 *    the ground sky drawn, darkness > 0 and the frame much darker at night — the same
 *    instruments, reading the other answer, so none of the absences is a renderer that draws
 *    nothing.
 *
 * Fog is **not** asserted here: in space it is the scheduler's to switch off at the
 * source (`R43`, `T22.08`), and a client that hid the veil while the server still
 * shrank the field of view would be a lie. Recorded in `T22.06`'s task file.
 *
 * Every wait counts drawn frames; the clock is pinned with `setTime`, never waited on.
 */

import { toScreen, underPhaser } from './pixels.mjs'
import { drawnFrames } from './harness.mjs'

/** Frames drawn after a state change before photographing it. */
const SETTLE_FRAMES = 6
/** Round seconds between the two photographed moments. */
const DT = 60
/**
 * The ground's day and night, round seconds (`sky-math.ts::darknessAt`: u 0.25 and
 * 0.75 of `CYCLE_LENGTH`), for the day/night absence and its presence control.
 */
const DAY_T = 30
const NIGHT_T = 90
/** Candidate first moments searched for one where the bodies are clear of the overlays. */
const SEARCH_STEP = 10
const SEARCH_SPAN = 600
/** A pixel counts as changed when some channel moves more than this. */
const THR = 10
/**
 * A body clear on screen at both moments must change at least this many pixels when
 * it alone is hidden, or the check fails (T22.06B F1: it used to log "not clear" and
 * pass, so the moon at alpha 0 went green).
 */
const BODY_PIXEL_FLOOR = 40
/**
 * How far a body's pixel centroid may sit from where `debug()` puts it, px. Measured
 * with both night sides hidden (T22.06B F3), so the whole disc is compared: sun 0.7,
 * earth and moon under 3 on the review's logs. It was `R/2 + 6` — 70 px on the earth.
 */
const POSITION_TOL = 6
/** T23.20: the sun's measuring box, in its radii (F3's star: an 8 px disc and its glow). */
const SUN_REACH = 3
/**
 * T23.20: an arc's limb is located `ARC_DEPTH` px below its top, where it is wide enough to cross (the planet's
 * 620 px arc: 2·√(2·620·20 − 20²) ≈ 312 px; the moon's 260: ≈ 243), within `LIMB_TOL` of its apex — F3's arcs are
 * stepped (`step` 5–6 px) and their rows jittered (`jitter` × step), so the edge sits up to a step off the circle.
 */
const ARC_DEPTH = { earth: 20, moon: 30 }
const LIMB_MARGIN = 24
const LIMB_ABOVE = 24
const LIMB_BELOW = 12
const LIMB_TOL = 10
/**
 * T23.20: the laser leg's numbers — `effect-lights`' (T23.09, measured there on the ground): the near patch within
 * this share of the light's radius gains at least `LASER_NEAR_MIN` mean luminance; rock past the radius + the margin
 * moves no channel more than `LASER_FAR_MAX`; each region needs `LASER_MIN_ROCK` px to mean anything.
 */
const LASER_NEAR_FRAC = 0.6
const LASER_NEAR_MIN = 4
const LASER_FAR_MARGIN = 120
const LASER_FAR_MAX = 3
const LASER_MIN_ROCK = 150
/** Ten-frame looks for the sandbox player to come to rest before a control patch is chosen. */
const SETTLE_TRIES = 60
/**
 * Point lights on the dark that make a star field, in the measured region: 60 star px at zoom 2, where each star
 * (one camera px) was 2 × 2 screen px. T23.10: a star px count scales with the zoom's square — `starFloor(zoom)` (15 at
 * zoom 1; measured 164 WebGL / 58 Canvas there, 711 at zoom 2).
 */
const STAR_FLOOR_ZOOM_2 = 60
const starFloor = (zoom) => Math.round((STAR_FLOOR_ZOOM_2 * zoom * zoom) / 4)
/** T23.04C F4: the flat day sky put under Phaser for the star counter's negative control. */
const DAY_SKY = '#9ec9ff'

export default async function ({ page, shot, log }) {
  const g = (fn, arg) => page.evaluate(fn, arg)
  const dbg = () => g(() => window.__game.debug())
  /** `n` drawn frames, or a throw naming a page that stopped rendering — the harness's one copy (T22.00C). */
  const frames = (n) => drawnFrames(page, n)
  const photo = async () => (await page.screenshot()).toString('base64')

  await page.waitForFunction(() => !!window.__game?.debug().player, null, { polling: 'raf', timeout: 60_000 })
  const k = await g(() => window.__game.constants())
  const url = new URL(page.url())
  if (url.searchParams.get('gravity') !== 'space') throw new Error('space-sky runs at ?gravity=space')
  const seedA = url.searchParams.get('seed') ?? '4242'
  const d0 = await dbg()
  const renderer = d0.renderer
  log(`renderer: ${renderer}`)
  if (renderer === 'webgl') await g(() => window.__game.setHighQuality(true))

  // --- frame: an asteroid dead centre of the screen, clear of the player ---------
  const rocks = await g(() => {
    const c = window.__game.core
    const cx = c.width / 2
    const cy = c.height / 2
    return [...c.meta.asteroids]
      .sort((p, q) => Math.hypot(p.x - cx, p.y - cy) - Math.hypot(q.x - cx, q.y - cy))
      .map((a) => ({ x: a.x, y: a.y, r: a.radius ?? a.r }))
  })
  if (!rocks.length) throw new Error('no asteroids — `?gravity=space` did not reach the scene')
  if (!rocks[0].r) throw new Error(`the asteroid has no radius field: ${JSON.stringify(rocks[0])}`)

  const vw = await g(() => ({ w: window.innerWidth, h: window.innerHeight }))
  // T23.20: the sandbox's panel covers the top-left of the frame, where F3 puts its star and its moon; the panel is
  // not under test here, so it is hidden (visibility only — it stays in the layout) and the overlays below omit it.
  await g(() => {
    const game = document.querySelector('canvas')
    for (const el of document.body.children) if (!el.contains(game)) el.style.visibility = 'hidden'
  })
  /**
   * The DOM over the canvas — the sandbox panel, the HUD strip, the suit line, the
   * minimap — read off the page rather than guessed.
   */
  const overlays = await g(() => {
    const game = document.querySelector('canvas')
    const out = []
    // Every element, not only the positioned ones: the panel's buttons overflow its box.
    for (const el of document.body.querySelectorAll('*')) {
      if (el === game || el.contains(game)) continue
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden') continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      // Full-screen layers (the feel layer, the death overlay's root) are transparent
      // containers; what they draw is small and is found as their own children.
      if (r.width * r.height > 0.4 * innerWidth * innerHeight) continue
      out.push({ x: Math.floor(r.left) - 2, y: Math.floor(r.top) - 2, w: Math.ceil(r.width) + 4, h: Math.ceil(r.height) + 4 })
    }
    return out
  })
  /**
   * The player and the crosshair beside it, **where they are now**: an asteroid's well
   * pulls the body in (T22.11B), and it animates on the browser's clock, so two
   * photographs with the scene unfrozen between them differ there whatever the sky
   * does. Excluded per photograph, from both photographs of a pair.
   */
  const playerBox = async () => {
    const p = (await dbg()).player
    const s = await toScreen(page, p.x, p.y)
    const half = 3 * k.PLAYER_H * s.scale
    return { x: Math.floor(s.x - half), y: Math.floor(s.y - half), w: Math.ceil(2 * half), h: Math.ceil(2 * half) }
  }
  const overlaps = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h
  const onScreen = (b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= vw.w && b.y + b.h <= vw.h
  /**
   * The control patch: inside an asteroid — terrain, drawn over the sky — and **clear
   * of the player** (T22.06B F2). The nearest rock to the map's centre is where the
   * sandbox player stands, so its patch sat wholly inside the player's exclusion box
   * and the control compared zero pixels. Rocks are tried outward from the centre
   * until one's patch is on screen, clear of every overlay and of the player with a
   * box's margin to spare for the well's pull.
   */
  // The sandbox player starts in open space and a well pulls it onto a rock; a patch
  // chosen while it is still falling is the one it lands on (seen: accepted clear,
  // then wholly under its box at the moments). So the body comes to rest first.
  let settled = false
  let prev = (await dbg()).player
  for (let i = 0; i < SETTLE_TRIES && !settled; i++) {
    await frames(10)
    const p = (await dbg()).player
    settled = Math.hypot(p.x - prev.x, p.y - prev.y) < 0.5
    prev = p
  }
  if (!settled) throw new Error(`the sandbox player did not come to rest in ${SETTLE_TRIES * 10} frames — no patch can be chosen clear of it`)
  // Chosen with the moments, below: `rockRect` joins `exclude` once it is.
  let rockRect = null
  let exclude = overlays
  log(`overlays excluded: ${overlays.map((r) => `${r.x},${r.y} ${r.w}×${r.h}`).join(' | ')}`)
  const overlapsAny = (b) => exclude.some((r) => overlaps(r, b))

  /** Everything measured at one frozen moment. */
  const moment = async (t, label) => {
    await g((tt) => {
      window.__game.freeze(false)
      window.__game.setTime(tt)
    }, t)
    await frames(SETTLE_FRAMES)
    await g(() => window.__game.freeze(true))
    await frames(2)
    const d = await dbg()
    const pb = await playerBox()
    const shown = await photo()
    const again = await photo()
    // T23.20: no night sides in F3's look — the frame as shown is the one each body is located in.
    const lit = shown
    const without = {}
    for (const name of ['sun', 'earth', 'moon']) {
      await g((n) => window.__game.setSpaceBodiesVisible(false, n), name)
      await frames(2)
      without[name] = await photo()
      await g((n) => window.__game.setSpaceBodiesVisible(true, n), name)
    }
    await g(() => window.__game.setSpaceBodiesVisible(false, 'all'))
    await frames(2)
    const bare = await photo()
    const bare2 = await photo()
    await g(() => window.__game.setSpaceBodiesVisible(true, 'all'))
    await frames(2)
    await shot(`space-sky-${renderer}-${label}`)
    return { t, d, pb, shown, again, lit, without, bare, bare2 }
  }

  /** In-page image maths: per-box changed-pixel centroids, star pixels, means. */
  const measure = (job) =>
    g(async (j) => {
      const load = async (src) => {
        const img = new Image()
        img.src = `data:image/png;base64,${src}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, img.width, img.height)
      }
      const inAny = (x, y, rects) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
      if (j.kind === 'diff') {
        const A = await load(j.a)
        const B = await load(j.b)
        const { width: W, height: H } = A
        const x0 = Math.max(0, Math.floor(j.box.x))
        const y0 = Math.max(0, Math.floor(j.box.y))
        const x1 = Math.min(W, Math.ceil(j.box.x + j.box.w))
        const y1 = Math.min(H, Math.ceil(j.box.y + j.box.h))
        let n = 0
        let sx = 0
        let sy = 0
        // How many pixels were compared at all: a region wholly inside an exclusion
        // reports n = 0 and would read as "unchanged" (T22.06B F2).
        let compared = 0
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (inAny(x, y, j.exclude)) continue
            compared++
            const i = (y * W + x) * 4
            const m = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]))
            if (m > j.thr) {
              n++
              sx += x
              sy += y
            }
          }
        }
        return { n, compared, cx: n ? sx / n : null, cy: n ? sy / n : null }
      }
      if (j.kind === 'limb') {
        // T23.20: an arc's limb — per column of the box, the first changed row from the top; their median row and
        // column, and how many columns found one (an arc's whole column below its limb is the arc).
        const A = await load(j.a)
        const B = await load(j.b)
        const { width: W, height: H } = A
        const x0 = Math.max(0, Math.floor(j.box.x))
        const y0 = Math.max(0, Math.floor(j.box.y))
        const x1 = Math.min(W, Math.ceil(j.box.x + j.box.w))
        const y1 = Math.min(H, Math.ceil(j.box.y + j.box.h))
        const tops = []
        for (let x = x0; x < x1; x++) {
          for (let y = y0; y < y1; y++) {
            if (inAny(x, y, j.exclude)) continue
            const i = (y * W + x) * 4
            const m = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]))
            if (m > j.thr) {
              tops.push(y)
              break
            }
          }
        }
        // The limb's top: the highest rows found, less the staircase's step (`tops` sorted, the lowest decile).
        const ys = [...tops].sort((p, q) => p - q)
        const top = ys.length ? ys[Math.floor(ys.length / 10)] : null
        if (top === null) return { n: 0, compared: (x1 - x0) * (y1 - y0), cx: null, cy: null, columns: 0 }
        // Its centre column: where the limb crosses the row `depth` below the top, left and right — the middle.
        const row = Math.min(y1 - 1, top + j.depth)
        let left = null
        let right = null
        for (let x = x0; x < x1; x++) {
          const i = (row * W + x) * 4
          const m = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]))
          if (m > j.thr && !inAny(x, row, j.exclude)) {
            left ??= x
            right = x
          }
        }
        const cx = left === null || right === null ? null : (left + right) / 2
        return { n: tops.length * Math.max(0, y1 - top), compared: (x1 - x0) * (y1 - y0), cx, cy: cx === null ? null : top, columns: tops.length, left, right }
      }
      if (j.kind === 'stars') {
        // A star is a point light on the dark: bright itself, dark around it. Rock and
        // a daytime sky fail the second half, which is what makes the standard frame a
        // control rather than an echo.
        const A = await load(j.a)
        const { width: W, height: H } = A
        const lum = (x, y) => {
          const i = (y * W + x) * 4
          return 0.2126 * A.data[i] + 0.7152 * A.data[i + 1] + 0.0722 * A.data[i + 2]
        }
        const out = []
        let total = 0
        let count = 0
        const gm = window.__game
        const dv = j.skyOnly ? gm.debug() : null
        const rockAt = dv ? (x, y) => gm.core.solidAt(Math.round(dv.worldView.x + x / dv.zoom), Math.round(dv.worldView.y + y / dv.zoom)) : null
        for (let y = 3; y < H - 3; y++) {
          for (let x = 3; x < W - 3; x++) {
            if (inAny(x, y, j.exclude)) continue
            // T23.20: the lit rock has bright specks of its own (pebbles, the lip light); a star is in the sky.
            if (rockAt && rockAt(x, y)) continue
            const L = lum(x, y)
            total += L
            count++
            if (L < 70) continue
            let ring = 0
            for (let d = -3; d <= 3; d++) ring += lum(x + d, y - 3) + lum(x + d, y + 3) + lum(x - 3, y + d) + lum(x + 3, y + d)
            if (ring / 28 < 40) out.push(y * W + x)
          }
        }
        return { stars: out, mean: total / count }
      }
      throw new Error(`unknown job ${j.kind}`)
    }, job)

  /**
   * T23.20: the box each body is measured in. The sun: its disc and glow, `SUN_REACH` radii. An arc (`ARC_DEPTH`): its
   * limb's top and the row `depth` below it, where the limb is `2√(2rd − d²)` wide — the box that wide and a margin,
   * from `LIMB_ABOVE` over the apex to `LIMB_BELOW` under that row.
   */
  const bodyBox = (b, name) => {
    if (name === 'sun') {
      const r = b.screenR * SUN_REACH
      return { x: b.screenX - r, y: b.screenY - r, w: 2 * r, h: 2 * r }
    }
    const d = ARC_DEPTH[name]
    const half = Math.sqrt(2 * b.screenR * d - d * d) + LIMB_MARGIN
    return { x: b.screenX - half, y: b.screenY - LIMB_ABOVE, w: 2 * half, h: LIMB_ABOVE + d + LIMB_BELOW }
  }

  const locate = async (m) => {
    const out = {}
    const sky = m.d.spaceSky
    if (!sky) throw new Error(`t=${m.t}: debug().spaceSky is null — the space sky is not up`)
    if (sky.drawer !== 'world') throw new Error(`t=${m.t}: the space sky is drawn by ${sky.drawer}, not the world renderer (T23.20)`)
    for (const name of ['sun', 'earth', 'moon']) {
      const b = sky[name]
      const box = bodyBox(b, name)
      const r =
        name === 'sun'
          ? await measure({ kind: 'diff', a: m.lit, b: m.without[name], box, exclude, thr: THR })
          : await measure({ kind: 'limb', a: m.lit, b: m.without[name], box, exclude, thr: THR, depth: ARC_DEPTH[name] })
      // Located only where the whole box is on the canvas and clear of every overlay:
      // a box clipped on one side has its centroid pulled to the other.
      // T23.10: and clear of the rock drawn over the sky — at zoom 1 the view holds four times the asteroids, and a
      // glow half under one pulled the centroid 8 px (the disc's on-screen size is unchanged, R6).
      const rock = await overRock(box)
      out[name] = { ...r, want: { x: b.screenX, y: b.screenY }, R: b.screenR, box, clear: onScreen(box) && !overlapsAny(box), rock }
    }
    return out
  }

  // ================================= space ========================================
  // --- choose the camera and the moments ------------------------------------------
  // A search over the sky's own positions (read, not predicted) rather than a
  // hardcoded time, which would rot the moment any orbit constant moved. The earth
  // must be clear at both moments; the more of the other two the better.
  /** T23.10: is any of screen box `bx` over rock (the asteroids, drawn over the sky)? */
  const overRock = (bx) =>
    page.evaluate((bx) => {
      const d = window.__game.debug()
      const v = d.worldView
      const c = window.__game.core
      for (let y = bx.y; y <= bx.y + bx.h; y += 4) for (let x = bx.x; x <= bx.x + bx.w; x += 4) if (c.solidAt(Math.round(v.x + x / d.zoom), Math.round(v.y + y / d.zoom))) return true
      return false
    }, bx)
  const searchMoments = async () => {
    const clearAt = new Map()
    for (let t = 0; t <= SEARCH_SPAN + DT; t += SEARCH_STEP) {
      await g((tt) => window.__game.setTime(tt), t)
      await frames(2)
      const sky = (await dbg()).spaceSky
      if (!sky) throw new Error('debug().spaceSky is null at ?gravity=space — the space sky never came up')
      const clear = []
      for (const n of ['sun', 'earth', 'moon']) {
        const box = bodyBox(sky[n], n)
        if (onScreen(box) && !overlapsAny(box) && !(await overRock(box))) clear.push(n)
      }
      clearAt.set(t, clear)
    }
    let T0 = null
    let best = -1
    for (let t = 0; t <= SEARCH_SPAN; t += SEARCH_STEP) {
      const both = clearAt.get(t).filter((n) => clearAt.get(t + DT).includes(n))
      if (both.includes('earth') && both.length > best) {
        best = both.length
        T0 = t
      }
    }
    return T0 === null ? null : { T0, best }
  }
  /**
   * The camera sits on an asteroid, and a patch inside it — terrain, drawn over the
   * sky — is the control region. **Clear of the player** (T22.06B F2): the rock
   * nearest the map's centre is where the sandbox player lands, so its patch sat
   * wholly inside the player's exclusion box and the control compared zero pixels.
   * Rocks are tried outward from the centre until one's patch is on screen, clear of
   * every overlay and of the player with a box's margin, **and** the sky from there
   * has moments with the earth clear (the patch is an exclusion the bodies avoid).
   */
  let rock = null
  let found = null
  const tried = []
  for (const cand of rocks.slice(0, 16)) {
    await g(([x, y]) => window.__game.watch(x, y), [cand.x, cand.y])
    // `worldView` refreshes in `preRender`: read through it only after frames are drawn.
    await frames(SETTLE_FRAMES)
    const s = await toScreen(page, cand.x, cand.y)
    const half = Math.max(6, Math.min(40, Math.floor(cand.r * 0.35 * s.scale)))
    const box = { x: Math.round(s.x - half), y: Math.round(s.y - half), w: half * 2, h: half * 2 }
    const pb = await playerBox()
    const wide = { x: pb.x - pb.w / 2, y: pb.y - pb.h / 2, w: pb.w * 2, h: pb.h * 2 }
    if (!onScreen(box) || overlays.some((r) => overlaps(r, box)) || overlaps(wide, box)) {
      tried.push(`${cand.x},${cand.y}: patch not clear`)
      continue
    }
    rockRect = box
    exclude = [...overlays, rockRect]
    found = await searchMoments()
    if (found) {
      rock = cand
      break
    }
    tried.push(`${cand.x},${cand.y}: no moment with the earth clear`)
  }
  if (!rock) throw new Error(`no asteroid near the centre gives a clear control patch and a clear earth: ${tried.join('; ')}`)
  const { T0, best } = found
  log(`control rock at ${rock.x},${rock.y} r ${rock.r}: patch ${rockRect.x},${rockRect.y} ${rockRect.w}×${rockRect.h}${tried.length ? ` (passed over ${tried.join('; ')})` : ''}`)
  log(`moments: t0 = ${T0} s, t1 = ${T0 + DT} s (${best} bodies clear at both)`)

  const a = await moment(T0, 't0')
  const b = await moment(T0 + DT, 't1')

  // --- the camera did not move, and the world did not darken ---------------------
  const va = a.d.worldView
  const vb = b.d.worldView
  if (va.x !== vb.x || va.y !== vb.y) throw new Error(`the camera moved between the moments: ${JSON.stringify(va)} → ${JSON.stringify(vb)}`)
  const rockDiff = await measure({ kind: 'diff', a: a.shown, b: b.shown, box: rockRect, exclude: [a.pb, b.pb], thr: THR })
  if (rockDiff.compared < (rockRect.w * rockRect.h) / 2) {
    throw new Error(`control: the asteroid patch compared only ${rockDiff.compared} of ${rockRect.w * rockRect.h} px — the player's box covers it`)
  }
  if (rockDiff.n > rockRect.w * rockRect.h * 0.01) {
    throw new Error(`control: the asteroid patch at the centre changed (${rockDiff.n} px) — the camera or the light moved, not the sky`)
  }
  const selfDiff = await measure({ kind: 'diff', a: a.shown, b: a.again, box: { x: 0, y: 0, w: vw.w, h: vw.h }, exclude, thr: THR })
  if (selfDiff.n > 50) throw new Error(`control: two photographs of one frozen moment differ by ${selfDiff.n} px`)
  log(`controls: camera still at ${va.x},${va.y}; asteroid patch ${rockDiff.n} of ${rockDiff.compared} px changed; same-moment pair ${selfDiff.n} px`)

  // --- 1 & 2: each body drawn where it says, and moved --------------------------
  const la = await locate(a)
  const lb = await locate(b)
  let moved = 0
  let measured = 0
  for (const name of ['sun', 'earth', 'moon']) {
    const [p, q] = [la[name], lb[name]]
    const fmt = (r) => (r.cx === null ? 'none' : `${r.cx.toFixed(0)},${r.cy.toFixed(0)} (${r.n} px)`)
    log(`${name}: t0 ${fmt(p)} want ${p.want.x.toFixed(0)},${p.want.y.toFixed(0)} | t1 ${fmt(q)} want ${q.want.x.toFixed(0)},${q.want.y.toFixed(0)}`)
    // "Not clear" and "drew nothing" are different answers (F1): only the first may
    // skip a body. A body whose box is on screen and clear of every overlay at both
    // moments **must** draw.
    if (!(p.clear && q.clear)) {
      if (name === 'earth') throw new Error(`the earth cannot be measured: clear ${p.clear} / ${q.clear}`)
      log(`${name}: not clear on screen at both moments, not measured`)
      continue
    }
    // T23.10: a body with an asteroid over part of its box is not where its pixels centre (the rock hides some).
    if (p.rock || q.rock) {
      log(`${name}: an asteroid over its box at ${p.rock ? 't0' : 't1'}, not measured`)
      continue
    }
    measured++
    if (p.n < BODY_PIXEL_FLOOR || q.n < BODY_PIXEL_FLOOR) {
      throw new Error(`${name}: clear on screen at both moments but hiding it changed only ${p.n} / ${q.n} px (want ≥ ${BODY_PIXEL_FLOOR}) — it is not drawn`)
    }
    for (const [r, when] of [[p, 't0'], [q, 't1']]) {
      const tol = name === 'sun' ? POSITION_TOL : LIMB_TOL
      if (r.cx === null) throw new Error(`${name} at ${when}: hiding it changed pixels but no limb crossing was found in its box`)
      const off = Math.hypot(r.cx - r.want.x, r.cy - r.want.y)
      if (off > tol) throw new Error(`${name} at ${when}: its pixels sit ${off.toFixed(1)} px from where debug() puts it (tolerance ${tol})`)
    }
    const seen = Math.hypot(q.cx - p.cx, q.cy - p.cy)
    const said = Math.hypot(q.want.x - p.want.x, q.want.y - p.want.y)
    if (said < 20) throw new Error(`${name}: debug() says it moved only ${said.toFixed(1)} px in ${DT} s — not visible motion`)
    if (Math.abs(seen - said) > Math.max(12, said * 0.3)) {
      throw new Error(`${name}: its pixels moved ${seen.toFixed(1)} px, debug() says ${said.toFixed(1)}`)
    }
    log(`${name}: moved ${seen.toFixed(1)} px on the frame over ${DT} s (debug ${said.toFixed(1)})`)
    moved++
  }
  if (moved < 2) throw new Error(`only ${moved} of the three bodies could be seen to move`)

  // --- 3: stars, and they drift -------------------------------------------------
  const both = [...exclude, a.pb, b.pb]
  const sa = await measure({ kind: 'stars', a: a.bare, exclude: both, skyOnly: true })
  const sa2 = await measure({ kind: 'stars', a: a.bare2, exclude: both, skyOnly: true })
  const sb = await measure({ kind: 'stars', a: b.bare, exclude: both, skyOnly: true })
  const STAR_FLOOR = starFloor((await dbg()).zoom)
  if (sa.stars.length < STAR_FLOOR) throw new Error(`only ${sa.stars.length} star pixels in space (want ≥ ${STAR_FLOOR})`)
  const kept = (x, y) => {
    const set = new Set(y.stars)
    return x.stars.filter((i) => set.has(i)).length / Math.max(1, x.stars.length)
  }
  const stay = kept(sa, sb)
  const still = kept(sa, sa2)
  if (!(still > 0.95)) throw new Error(`control: only ${(still * 100).toFixed(0)} % of star pixels survive a second photograph of the same moment`)
  if (!(stay < 0.35)) throw new Error(`the stars did not drift: ${(stay * 100).toFixed(0)} % of star pixels are where they were ${DT} s earlier`)
  log(`stars: ${sa.stars.length} star pixels; ${(still * 100).toFixed(0)} % in place in a second photograph, ${(stay * 100).toFixed(0)} % after ${DT} s`)

  // --- 5a: the absences, in space -----------------------------------------------
  // The ground's day and night, bodies hidden: the frame must not darken.
  const bareAt = async (t) => {
    await g((tt) => {
      window.__game.setTime(tt)
      window.__game.setSpaceBodiesVisible(false, 'all')
    }, t)
    await frames(SETTLE_FRAMES)
    const out = { d: await dbg(), pb: await playerBox(), p: await photo() }
    await g(() => window.__game.setSpaceBodiesVisible(true, 'all'))
    return out
  }
  const dayBare = await bareAt(DAY_T)
  const nightBare = await bareAt(NIGHT_T)
  const dn = [...exclude, dayBare.pb, nightBare.pb]
  const sDay = await measure({ kind: 'stars', a: dayBare.p, exclude: dn })
  const sNight = await measure({ kind: 'stars', a: nightBare.p, exclude: dn })
  const nightMean = sNight.mean - sDay.mean
  if (Math.abs(nightMean) > 3) throw new Error(`the space frame changed brightness by ${nightMean.toFixed(1)} between the ground's day and night`)
  if (nightBare.d.darkness !== 0) throw new Error(`darkness at the ground's night in space is ${nightBare.d.darkness}, not 0`)
  // T23.20: the world renderer draws space's own sky (F3's), not the ground's.
  const groundSky = await g(() => window.__world?.info()?.spaceSky ?? null)
  if (groundSky !== true) throw new Error(`the world renderer does not draw space's sky in space (spaceSky: ${groundSky})`)
  if (b.d.caveBackdrop !== false) throw new Error(`the cave backdrop is on for a space map (R33)`)
  const refused = await g(() => window.__game.caveBackdrop(true))
  if (refused !== false) throw new Error('a space map accepted the cave backdrop toggle')
  log(`space: darkness ${nightBare.d.darkness} at the ground's night, frame Δ ${nightMean.toFixed(2)} day→night, space's sky drawn, no cave`)

  // --- 4: seeded -------------------------------------------------------------------
  await g((t) => {
    window.__game.freeze(false)
    window.__game.setTime(t)
  }, T0)
  const hashA = a.d.spaceSky.starHash
  if (a.d.spaceSky.seed !== (Number(BigInt(seedA) & 0xffffffffn) | 0)) {
    throw new Error(`the sky is seeded ${a.d.spaceSky.seed}, the map ${seedA}`)
  }
  const reseed = async (s) => {
    await g((v) => window.__game.setSkySeed(v), s)
    await g(() => window.__game.freeze(false))
    await frames(SETTLE_FRAMES)
    await g(() => window.__game.freeze(true))
    await frames(2)
    return { d: await dbg(), pb: await playerBox(), p: await photo() }
  }
  const other = await reseed(Number(seedA) + 1)
  const back = await reseed(Number(seedA))
  await g(() => window.__game.freeze(false))
  const all = { x: 0, y: 0, w: vw.w, h: vw.h }
  const dOther = await measure({ kind: 'diff', a: a.shown, b: other.p, box: all, exclude: [...exclude, a.pb, other.pb], thr: THR })
  const dBack = await measure({ kind: 'diff', a: a.shown, b: back.p, box: all, exclude: [...exclude, a.pb, back.pb], thr: THR })
  if (other.d.spaceSky.starHash === hashA) throw new Error('two seeds drew the same star field')
  if (dOther.n < 500) throw new Error(`another seed changed only ${dOther.n} px of the sky`)
  if (back.d.spaceSky.starHash !== hashA || dBack.n > 50) {
    throw new Error(`the first seed again did not give the first sky back: ${dBack.n} px differ`)
  }
  log(`seeded: another seed changes ${dOther.n} px, the first again ${dBack.n} px`)

  // --- 6 (T23.20): the fight lights the asteroids — a laser's impact on the rock it hits ------------------------------
  // F3's rock is lit by the star and by the fight. The same frozen frame read twice from the world canvas — as drawn,
  // and with only the laser-impact light taken out of the lights the terrain drew — so the only difference is that
  // light: rock near it brightens (the patch), rock past its radius does not move (the far patch, the control).
  await g(() => window.__game.watch(null))
  await frames(SETTLE_FRAMES)
  const slot = await g(() => window.__game.giveLaser())
  if (!(slot >= 0)) throw new Error('the sandbox would not give a laser pistol')
  await g((sl) => window.__game.selectSlot(sl), slot)
  await g(() => window.__game.holdTracers(true))
  const me = (await dbg()).player
  // Into the rock the player stands on, beside the feet (a space player is on an asteroid: `settled` above).
  const target = await g(([x, y]) => {
    const c = window.__game.core
    for (let r = 30; r < 200; r += 6) for (let a = 0; a < 16; a++) {
      const tx = Math.round(x + r * Math.cos((a / 16) * Math.PI * 2))
      const ty = Math.round(y + r * Math.sin((a / 16) * Math.PI * 2))
      if (c.solidAt(tx, ty) && !c.solidAt(Math.round(x + (r - 6) * Math.cos((a / 16) * Math.PI * 2)), Math.round(y + (r - 6) * Math.sin((a / 16) * Math.PI * 2)))) return [tx, ty]
    }
    return null
  }, [Math.round(me.x), Math.round(me.y - k.PLAYER_H / 2)])
  if (!target) throw new Error('no rock within 200 px of the player to shoot the laser at')
  const aimAt = await toScreen(page, target[0], target[1])
  await page.mouse.move(aimAt.x, aimAt.y)
  await frames(3)
  const beam = await g(async () => {
    const t0 = performance.now()
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    while (performance.now() - t0 < 5000) {
      const ev = window.__game.fire()
      if (ev?.hitscan?.length) break
      await raf()
    }
    while (performance.now() - t0 < 8000) {
      await raf()
      const l = window.__game.effectLights().find((e) => e.kind === 'laser')
      if (l) {
        await raf()
        window.__game.freeze(true)
        await raf()
        return window.__game.effectLights().find((e) => e.kind === 'laser') ?? null
      }
    }
    return null
  })
  if (!beam) throw new Error('laser: no laser-impact light reached the list in space')
  const decodeF = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')), view: f.view })
  const drawnL = await g(() => window.__world.drawnLights())
  const heldL = await g(() => window.__world.lights())
  const sameL = (l) => l.x === beam.x && l.y === beam.y && l.r === beam.r && l.i === beam.i
  if (drawnL.filter(sameL).length !== 1) throw new Error(`laser: the terrain did not draw the impact light once: ${JSON.stringify(beam)} in ${JSON.stringify(drawnL)}`)
  await g(() => window.__world.setActors([]))
  const lOn = decodeF(await g(() => window.__world.readFrame()))
  await g((l) => window.__world.setLights(l), drawnL.filter((l) => !sameL(l)))
  const lOff = decodeF(await g(() => window.__world.readFrame()))
  await g((l) => window.__world.setLights(l), heldL)
  await g(() => window.__world.setActors(null))
  await g(() => window.__game.holdTracers(false))
  await g(() => window.__game.freeze(false))
  const rockMask = await g(([v, w, h]) => {
    const c = window.__game.core
    const kk = w / v.w
    let out = ''
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out += c.solidAt(Math.floor(v.x + (x + 0.5) / kk), Math.floor(v.y + (y + 0.5) / kk)) ? '1' : '0'
    return out
  }, [lOn.view, lOn.width, lOn.height])
  const kk = lOn.width / lOn.view.w
  const near = { n: 0, gain: 0 }
  const far = { n: 0, max: 0 }
  const lumaAt = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]
  for (let y = 0; y < lOn.height; y++) {
    for (let x = 0; x < lOn.width; x++) {
      if (rockMask[y * lOn.width + x] !== '1') continue
      const dd = Math.hypot(lOn.view.x + (x + 0.5) / kk - beam.x, lOn.view.y + (y + 0.5) / kk - beam.y)
      const o = (y * lOn.width + x) * 4
      if (dd < beam.r * LASER_NEAR_FRAC) {
        near.n++
        near.gain += lumaAt(lOn.data, o) - lumaAt(lOff.data, o)
      } else if (dd > beam.r + LASER_FAR_MARGIN) {
        far.n++
        for (let c = 0; c < 3; c++) far.max = Math.max(far.max, Math.abs(lOn.data[o + c] - lOff.data[o + c]))
      }
    }
  }
  near.gain = near.n ? near.gain / near.n : 0
  log(`laser impact in space ${JSON.stringify(beam)}: near ${near.n} rock px, gain ${near.gain.toFixed(2)} (min ${LASER_NEAR_MIN}); far ${far.n} rock px, max change ${far.max} (max ${LASER_FAR_MAX})`)
  await shot('space-sky-laser')
  if (near.n < LASER_MIN_ROCK) throw new Error(`laser: only ${near.n} rock px near the impact (min ${LASER_MIN_ROCK})`)
  if (!(near.gain >= LASER_NEAR_MIN)) throw new Error(`laser: the asteroid near the impact gains only ${near.gain.toFixed(2)} luminance — the fight does not light the rock in space`)
  if (far.n < LASER_MIN_ROCK) throw new Error(`laser: control — only ${far.n} rock px beyond the light's radius (min ${LASER_MIN_ROCK})`)
  if (far.max > LASER_FAR_MAX) throw new Error(`laser: control — rock beyond the light's radius changed by ${far.max}; the whole frame moved`)

  // ================= standard: the same instruments, the other answer ===============
  await g(() => window.__game.regenerate(undefined, undefined, 'standard'))
  await page.waitForFunction(() => window.__game.core.meta.asteroids.length === 0 && !!window.__game.debug().player, null, {
    polling: 'raf',
    timeout: 60_000,
  })
  // Where the player stands: rock and air, so night's darkening has terrain to fall on. (It
  // was the top of the map, for the retired clouds and rain; the new sky is F1's night at every
  // hour until T23.11's blend, so a frame of sky alone no longer darkens at night.)
  const top = await g(() => window.__game.debug().player)
  await g(([x, y]) => window.__game.watch(x, y), [top.x, top.y])
  const std = async (t) => {
    await g((tt) => window.__game.setTime(tt), t)
    await frames(SETTLE_FRAMES)
    return { d: await dbg(), p: await photo() }
  }
  const day = await std(DAY_T)
  const groundUp = await g(() => (window.__world?.info()?.spaceSky === false ? window.__world.info().sky : null))
  const night = await std(NIGHT_T)
  await shot(`space-sky-${renderer}-standard-night`)
  const dm = await measure({ kind: 'stars', a: day.p, exclude })
  const nm = await measure({ kind: 'stars', a: night.p, exclude })
  const problems = []
  if (day.d.spaceSky !== null) problems.push('the space sky is up in standard gravity')
  if (groundUp !== true) problems.push(`the ground's sky is not drawn on the standard map (world renderer sky: ${groundUp})`)
  if (!(night.d.darkness > 0.5 * k.NIGHT_DARKNESS)) problems.push(`night darkness ${night.d.darkness}`)
  // The presence control's pixel half (T23.07 retired it while the world was F1's night at every hour; T23.11 put
  // it back): on the standard map night darkens the frame — F5's moonlit day → F1's night and the night view (R7).
  // T23.19G F10: it holds with the blend deleted (the night view alone darkens outside the sight), so it is not evidence
  // for the blend — `look-day-night-match` is; do not retire that one as redundant with this.
  if (!(dm.mean - nm.mean > 15)) problems.push(`night darkened the frame by only ${(dm.mean - nm.mean).toFixed(1)}`)
  log(`standard: night darkened the frame's mean by ${(dm.mean - nm.mean).toFixed(1)} (min 15)`)
  // T23.04C F4: the star counter's negative control, back. (Retired in T23.04: "the daytime sky
  // counts < STAR_FLOOR / 4" — the ground sky is F1's night, stars included, at every hour until
  // T23.11.) So the day sky is supplied without the world renderer: at the top of the map, open
  // sky, the world canvas hidden under Phaser and the page behind it one flat, bright day-sky colour
  // — bright everywhere, so the counter's "dark around it" half must reject all of it, as it
  // rejected the old daytime sky. It proves the counter counts stars, not any bright pixel.
  // By day: night's darkening is Phaser's own layer, over the backdrop as over the sky.
  await g(() => window.__game.watch(window.__game.core.width / 2, 200))
  await g((tt) => window.__game.setTime(tt), DAY_T)
  await frames(SETTLE_FRAMES)
  const hid = await underPhaser(page, DAY_SKY)
  const flatDay = await photo()
  await underPhaser(page, null)
  const fm = await measure({ kind: 'stars', a: flatDay, exclude })
  const flatMean = fm.mean
  if (hid.world && !hid.hidden) problems.push('control: the world canvas would not hide for the flat day sky')
  if (!(flatMean > 100)) problems.push(`control: the flat day sky photographed at mean luminance ${flatMean.toFixed(1)} — it is not a bright sky`)
  if (!(fm.stars.length < STAR_FLOOR / 4)) problems.push(`control: a flat bright day sky counts as ${fm.stars.length} star pixels (want < ${STAR_FLOOR / 4}) — the star instrument is not discriminating`)
  if (problems.length) throw new Error(`presence controls (standard gravity) failed: ${problems.join('; ')}`)
  log(
    `standard control: ground sky drawn, night darkness ${night.d.darkness.toFixed(2)}, ` +
      `frame darkened ${(dm.mean - nm.mean).toFixed(1)}, ${dm.stars.length} star pixels by day; ` +
      `control: a flat day sky (${DAY_SKY}, mean luminance ${flatMean.toFixed(1)}) counts ${fm.stars.length} (< ${STAR_FLOOR / 4})`,
  )
  await g(() => {
    window.__game.watch(null)
    window.__game.setTime(null)
  })
}
