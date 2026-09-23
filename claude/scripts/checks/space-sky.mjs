/**
 * T22.06 — **the space backdrop, on the rendered frame** (`docs/72` §C2), in the sandbox
 * at `?gravity=space` (R22), and the ground sky it replaces as the presence control.
 *
 * The owner: *"there's no day/light in space but the sun and moon and the earth and
 * stars can be the background and should move. there are no clouds or fog or anything
 * like that."* So, on one page, one camera, one frozen round clock at a time:
 *
 * 1. **Each body is drawn where it says it is.** For the sun, the earth and the moon
 *    separately: the frame with that body hidden (`setSpaceBodiesVisible(false, name)`)
 *    is its control frame, the pixels that differ are that body and no other, and their
 *    centroid must sit on the screen position `debug()` reports.
 * 2. **They move across a round.** The same measurement `DT` round-seconds later: each
 *    body's *pixel* centroid moved, by about what `debug()` says it moved. **The camera
 *    did not do it**: the camera's view is asserted identical, and a patch of asteroid at
 *    the centre of the screen — terrain, drawn over the sky — is the control region that
 *    must not change (it would, if the camera had moved or the world had darkened).
 * 3. **Stars, and they drift.** Point lights on the dark counted in the all-bodies-hidden
 *    frame; at `DT` later few of them are where they were, while a second photograph of
 *    the same moment is the control that they are not simply flickering.
 * 4. **Seeded.** Re-seeding the sky alone (`setSkySeed`) moves the stars and bodies; the
 *    first seed again gives the first frame back.
 * 5. **Absences, each beside its presence.** In space: the ridge band suppressed and not
 *    visible, no cloud drawn, no ambient rain even when forced, darkness 0 at the ground's
 *    night, and the frame no darker at `T0 + DT` (the ground's night) than at `T0`. Then
 *    the **same page regenerated standard**: ridge visible, clouds drawn, forced rain
 *    falling, darkness > 0 and the frame much darker at night — the same instruments,
 *    reading the other answer, so none of the absences is a renderer that draws nothing.
 *
 * Fog is **not** asserted here: in space it is the scheduler's to switch off at the
 * source (`R43`, `T22.08`), and a client that hid the veil while the server still
 * shrank the field of view would be a lie. Recorded in `T22.06`'s task file.
 *
 * Every wait counts drawn frames; the clock is pinned with `setTime`, never waited on.
 */

import { toScreen } from './pixels.mjs'

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
/** A body is "drawn" if at least this many pixels change when it alone is hidden. */
const BODY_PIXEL_FLOOR = 40
/** Point lights on the dark that make a star field, in the measured region. */
const STAR_FLOOR = 60

export default async function ({ page, shot, log }) {
  const g = (fn, arg) => page.evaluate(fn, arg)
  const dbg = () => g(() => window.__game.debug())
  const frames = (n) =>
    g(
      (count) =>
        new Promise((resolve) => {
          let left = count
          const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
          requestAnimationFrame(tick)
        }),
      n,
    )
  const photo = async () => (await page.screenshot()).toString('base64')

  await page.waitForFunction(() => !!window.__game?.debug().player, null, { polling: 'raf', timeout: 60_000 })
  const k = await g(() => window.__game.constants())
  const url = new URL(page.url())
  if (url.searchParams.get('gravity') !== 'space') throw new Error('space-sky runs at ?gravity=space')
  const seedA = url.searchParams.get('seed') ?? '4242'
  const d0 = await dbg()
  const renderer = d0.parallax?.renderer
  log(`renderer: ${renderer}`)
  if (renderer === 'webgl') await g(() => window.__game.setHighQuality(true))

  // --- frame: the asteroid nearest the map's centre, dead centre of the screen ---
  const rock = await g(() => {
    const c = window.__game.core
    const cx = c.width / 2
    const cy = c.height / 2
    const a = [...c.meta.asteroids].sort((p, q) => Math.hypot(p.x - cx, p.y - cy) - Math.hypot(q.x - cx, q.y - cy))[0]
    return a ? { x: a.x, y: a.y, r: a.radius ?? a.r } : null
  })
  if (!rock) throw new Error('no asteroids — `?gravity=space` did not reach the scene')
  if (!rock.r) throw new Error(`the asteroid has no radius field: ${JSON.stringify(rock)}`)
  await g(([x, y]) => {
    window.__game.watch(x, y)
    window.__game.forceAmbient(1)
  }, [rock.x, rock.y])
  // `worldView` refreshes in `preRender`: read through it only after frames are drawn.
  await frames(SETTLE_FRAMES)

  const vw = await g(() => ({ w: window.innerWidth, h: window.innerHeight }))
  /** Inside the asteroid, around the screen centre: terrain, drawn over the sky. */
  const rockHalf = Math.max(6, Math.min(40, Math.floor(rock.r * 0.35 * 2)))
  const rockRect = { x: Math.round(vw.w / 2 - rockHalf), y: Math.round(vw.h / 2 - rockHalf), w: rockHalf * 2, h: rockHalf * 2 }
  /**
   * The DOM over the canvas — the sandbox panel, the HUD strip, the suit line, the
   * minimap — read off the page rather than guessed, plus the centre asteroid patch.
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
  const exclude = [...overlays, rockRect]
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
  log(`overlays excluded: ${overlays.map((r) => `${r.x},${r.y} ${r.w}×${r.h}`).join(' | ')}`)
  const overlapsAny = (b) => exclude.some((r) => b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h)
  const onScreen = (b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= vw.w && b.y + b.h <= vw.h

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
    return { t, d, pb, shown, again, without, bare, bare2 }
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
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (inAny(x, y, j.exclude)) continue
            const i = (y * W + x) * 4
            const m = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]))
            if (m > j.thr) {
              n++
              sx += x
              sy += y
            }
          }
        }
        return { n, cx: n ? sx / n : null, cy: n ? sy / n : null }
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
        for (let y = 3; y < H - 3; y++) {
          for (let x = 3; x < W - 3; x++) {
            if (inAny(x, y, j.exclude)) continue
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

  const bodyBox = (b, scale) => {
    const r = b.screenR * scale
    return { x: b.screenX - r, y: b.screenY - r, w: 2 * r, h: 2 * r }
  }
  /**
   * The box each body is measured in, in radii: the disc and its rim of glow. The sun's
   * glow reaches `SPACE_SUN_GLOW` radii but fades out long before that on the frame.
   */
  const REACH = { sun: 2, earth: 1.05, moon: 1.1 }

  const locate = async (m) => {
    const out = {}
    const sky = m.d.spaceSky
    if (!sky) throw new Error(`t=${m.t}: debug().spaceSky is null — the space sky is not up`)
    for (const name of ['sun', 'earth', 'moon']) {
      const b = sky[name]
      const box = bodyBox(b, REACH[name])
      const r = await measure({ kind: 'diff', a: m.shown, b: m.without[name], box, exclude, thr: THR })
      // Located only where the whole box is on the canvas and clear of every overlay:
      // a box clipped on one side has its centroid pulled to the other.
      out[name] = { ...r, want: { x: b.screenX, y: b.screenY }, R: b.screenR, box, clear: onScreen(box) && !overlapsAny(box) }
    }
    return out
  }

  // ================================= space ========================================
  // --- choose the moments: the bodies' boxes clear of every overlay -----------------
  // A search over the sky's own positions (read, not predicted) rather than a
  // hardcoded time, which would rot the moment any orbit constant moved. The earth
  // must be clear at both moments; the more of the other two the better.
  const clearAt = new Map()
  for (let t = 0; t <= SEARCH_SPAN + DT; t += SEARCH_STEP) {
    await g((tt) => window.__game.setTime(tt), t)
    await frames(2)
    const sky = (await dbg()).spaceSky
    if (!sky) throw new Error('debug().spaceSky is null at ?gravity=space — the space sky never came up')
    clearAt.set(
      t,
      ['sun', 'earth', 'moon'].filter((n) => {
        const box = bodyBox(sky[n], REACH[n])
        return onScreen(box) && !overlapsAny(box)
      }),
    )
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
  if (T0 === null) throw new Error(`no moment in ${SEARCH_SPAN} s has the earth clear of the overlays at t and t + ${DT}`)
  log(`moments: t0 = ${T0} s, t1 = ${T0 + DT} s (${best} bodies clear at both)`)

  const a = await moment(T0, 't0')
  const b = await moment(T0 + DT, 't1')

  // --- the camera did not move, and the world did not darken ---------------------
  const va = a.d.worldView
  const vb = b.d.worldView
  if (va.x !== vb.x || va.y !== vb.y) throw new Error(`the camera moved between the moments: ${JSON.stringify(va)} → ${JSON.stringify(vb)}`)
  const rockDiff = await measure({ kind: 'diff', a: a.shown, b: b.shown, box: rockRect, exclude: [a.pb, b.pb], thr: THR })
  if (rockDiff.n > rockRect.w * rockRect.h * 0.01) {
    throw new Error(`control: the asteroid patch at the centre changed (${rockDiff.n} px) — the camera or the light moved, not the sky`)
  }
  const selfDiff = await measure({ kind: 'diff', a: a.shown, b: a.again, box: { x: 0, y: 0, w: vw.w, h: vw.h }, exclude, thr: THR })
  if (selfDiff.n > 50) throw new Error(`control: two photographs of one frozen moment differ by ${selfDiff.n} px`)
  log(`controls: camera still at ${va.x},${va.y}; asteroid patch ${rockDiff.n} px changed; same-moment pair ${selfDiff.n} px`)

  // --- 1 & 2: each body drawn where it says, and moved --------------------------
  const la = await locate(a)
  const lb = await locate(b)
  let moved = 0
  for (const name of ['sun', 'earth', 'moon']) {
    const [p, q] = [la[name], lb[name]]
    const fmt = (r) => (r.cx === null ? 'none' : `${r.cx.toFixed(0)},${r.cy.toFixed(0)} (${r.n} px)`)
    log(`${name}: t0 ${fmt(p)} want ${p.want.x.toFixed(0)},${p.want.y.toFixed(0)} | t1 ${fmt(q)} want ${q.want.x.toFixed(0)},${q.want.y.toFixed(0)}`)
    const drawn = p.n >= BODY_PIXEL_FLOOR && q.n >= BODY_PIXEL_FLOOR && p.clear && q.clear
    if (!drawn) {
      // The earth is the one that must always be measurable; a sun or moon behind the
      // asteroid, under an overlay or off the edge at one moment is covered by the others.
      if (name === 'earth') throw new Error(`the earth cannot be measured: ${p.n} / ${q.n} px, clear ${p.clear} / ${q.clear}`)
      log(`${name}: not clear on screen at both moments, not measured`)
      continue
    }
    for (const [r, when] of [[p, 't0'], [q, 't1']]) {
      const off = Math.hypot(r.cx - r.want.x, r.cy - r.want.y)
      if (off > r.R * 0.5 + 6) throw new Error(`${name} at ${when}: its pixels centre ${off.toFixed(1)} px from where debug() puts it (R ${r.R})`)
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
  const sa = await measure({ kind: 'stars', a: a.bare, exclude: both })
  const sa2 = await measure({ kind: 'stars', a: a.bare2, exclude: both })
  const sb = await measure({ kind: 'stars', a: b.bare, exclude: both })
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
  const par = b.d.parallax
  if (!par.suppressed || par.ridgeVisible || par.cloudsDrawn !== 0) {
    throw new Error(`the ground's sky band is up in space: ${JSON.stringify({ s: par.suppressed, ridge: par.ridgeVisible, clouds: par.cloudsDrawn })}`)
  }
  if (b.d.ambientAsked !== 0 || b.d.ambientDrops !== 0) {
    throw new Error(`forced ambient rain fell in space: asked ${b.d.ambientAsked}, drops ${b.d.ambientDrops}`)
  }
  if (b.d.caveBackdrop !== false) throw new Error(`the cave backdrop is on for a space map (R33)`)
  const refused = await g(() => window.__game.caveBackdrop(true))
  if (refused !== false) throw new Error('a space map accepted the cave backdrop toggle')
  log(`space: darkness ${nightBare.d.darkness} at the ground's night, frame Δ ${nightMean.toFixed(2)} day→night, ridge off, 0 clouds, 0 drops forced, no cave`)

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

  // ================= standard: the same instruments, the other answer ===============
  await g(() => window.__game.regenerate(undefined, undefined, 'standard'))
  await page.waitForFunction(() => window.__game.core.meta.asteroids.length === 0 && !!window.__game.debug().player, null, {
    polling: 'raf',
    timeout: 60_000,
  })
  // The top of the map: open sky, clouds overhead, rain falling from them.
  const top = await g(() => ({ x: window.__game.core.width / 2, y: 200 }))
  await g(([x, y]) => {
    window.__game.watch(x, y)
    window.__game.forceAmbient(1)
    window.__game.setParallaxClock(0)
  }, [top.x, top.y])
  const std = async (t) => {
    await g((tt) => window.__game.setTime(tt), t)
    await frames(SETTLE_FRAMES)
    return { d: await dbg(), p: await photo() }
  }
  const day = await std(DAY_T)
  // Rain from a cloud to the bottom of the view is a fall, counted in frames; the
  // drops are the proof the forced shower is not refused here.
  await page.waitForFunction(() => window.__game.debug().ambientDrops > 0, null, { polling: 'raf', timeout: 60_000 }).catch(() => {})
  const wet = await dbg()
  const night = await std(NIGHT_T)
  await shot(`space-sky-${renderer}-standard-night`)
  const dm = await measure({ kind: 'stars', a: day.p, exclude })
  const nm = await measure({ kind: 'stars', a: night.p, exclude })
  const pd = day.d.parallax
  const problems = []
  if (day.d.spaceSky !== null) problems.push('the space sky is up in standard gravity')
  if (pd.suppressed || !pd.ridgeVisible) problems.push(`ridge not visible (suppressed ${pd.suppressed})`)
  if (!(pd.cloudsDrawn > 0)) problems.push('no clouds drawn over the top of the map')
  if (!(wet.ambientDrops > 0)) problems.push('forced ambient rain drew no drops')
  if (!(night.d.darkness > 0.5 * k.NIGHT_DARKNESS)) problems.push(`night darkness ${night.d.darkness}`)
  if (!(dm.mean - nm.mean > 15)) problems.push(`night darkened the frame by only ${(dm.mean - nm.mean).toFixed(1)}`)
  if (!(dm.stars.length < STAR_FLOOR / 4)) problems.push(`the daytime sky counts as ${dm.stars.length} star pixels — the star instrument is not discriminating`)
  if (problems.length) throw new Error(`presence controls (standard gravity) failed: ${problems.join('; ')}`)
  log(
    `standard control: ridge up, ${pd.cloudsDrawn} clouds, ${wet.ambientDrops} drops, night darkness ${night.d.darkness.toFixed(2)}, ` +
      `frame darkened ${(dm.mean - nm.mean).toFixed(1)}, ${dm.stars.length} star pixels by day`,
  )
  await g(() => {
    window.__game.forceAmbient(null)
    window.__game.watch(null)
    window.__game.setTime(null)
    window.__game.setParallaxClock(null)
  })
}
