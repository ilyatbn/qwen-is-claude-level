/**
 * T22.16 / `M22-OWNER-ROUND-2` R102 — **an asteroid's core is drawn, round and
 * distinct, at its centre** — and a destroyed one is gone from the frame.
 *
 * The owner: *"make like a round core at the center"*. Everything the core does in
 * the simulation is proven in Rust (`world/cores.rs`); this is the half no Rust test
 * can see: the pixels (`docs/72` §C2).
 *
 * ## What is photographed, and the controls
 *
 * One rock, the camera held on its centre, the sky and parallax pinned:
 *
 *  - **subject** — a patch inside the core's heart, at the rock's centre;
 *  - **control region** — a patch of the same rock's body outside the core, on a
 *    bearing whose whole patch is solid rock (read off the core's mask).
 *
 * The **intact frame** must show the subject distinctly coloured from the control
 * region (colour distance), and *warmer* (red over blue, by a margin over the rock's
 * own) — the core, not a lighting gradient. The **control frame** is the same rock,
 * camera and moment with the core carved away on the client's core (`Core.carve`,
 * the carve the server's crumble sends): the subject changes and is no longer warm,
 * while the control region does not move — so the colour was the core's pixels and
 * nothing else in the frame. Run on both renderers (`asteroid-cores-canvas`).
 *
 * ## No wall-clock sleeps
 *
 * Waits are on rendered frames (`requestAnimationFrame`), the rebake on the core's
 * dirty set emptying — never `waitForTimeout`.
 */
import { deadlineMs } from '../lib/deadline.mjs'
import { colourDelta, samplePatch, toScreen } from './pixels.mjs'

/** Mean colour distance the core's heart must stand off the rock body by (0..441). */
const DISTINCT_MIN = 60
/**
 * How much redder-than-blue the heart must read than the rock body does. The core's
 * colours are an ember rim and an amber heart; the rock is grey — so this is the
 * core's warmth, not a tint the whole frame shares.
 */
const WARM_MIN = 60
/** How far the control region may move between the two frames (mean colour). */
const UNCHANGED_MAX = 6
/** Rendered frames to let a pin, a placement or a rebake reach the screen. */
const SETTLE_FRAMES = 20

export default async function ({ page, shot, log }) {
  const waitFor = async (fn, arg, why, seconds = 20) => {
    try {
      await page.waitForFunction(fn, arg, { timeout: deadlineMs(seconds, why) })
    } catch (e) {
      if (String(e).includes('Timeout')) throw new Error(`${why} (waited ${seconds}s)`)
      throw e
    }
  }
  const frames = async (n) => {
    await page.evaluate(() => {
      window.__e2eFrames = 0
      if (window.__e2eTick) return
      window.__e2eTick = true
      const tick = () => {
        window.__e2eFrames++
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await waitFor((m) => window.__e2eFrames >= m, n, `${n} frames never rendered`)
  }

  await waitFor(() => !!window.__game.debug().player, null, 'the sandbox never produced a local player')
  const k = await page.evaluate(() => window.__game.constants())
  // One pair of photographs per renderer, so the Canvas run does not overwrite WebGL's.
  const tag = (await page.evaluate(() => location.search.includes('renderer=canvas'))) ? '-canvas' : ''

  // The rocks and their core discs, both off the core (the discs' radius is Rust's).
  const pick = await page.evaluate(
    ([halfW, halfH, bodyH]) => {
      const core = window.__game.core
      const rocks = core.meta.asteroids
      const flat = Array.from(core.coreDiscs())
      const solidBox = (x, y, half) => {
        for (let dy = -half; dy <= half; dy++) {
          for (let dx = -half; dx <= half; dx++) {
            if (!core.solidAt(Math.round(x + dx), Math.round(y + dy))) return false
          }
        }
        return true
      }
      const out = []
      rocks.forEach((a, i) => {
        const c = flat[i * 3 + 2]
        if (flat[i * 3] !== a.x || flat[i * 3 + 1] !== a.y) return
        // The camera can centre on it (the rig clamps to the map).
        if (a.x < halfW || a.x > core.width - halfW || a.y < halfH || a.y > core.height - halfH) return
        // A patch well inside the heart (the heart is 0.55 of the core).
        const side = Math.max(2, Math.floor((c + 0.5) * 0.55 * 0.7))
        if (!solidBox(a.x, a.y, side)) return
        // The control: rock body just outside the core (two patches clear of it), on
        // a downward bearing (the body floats above the rock), wholly solid.
        const d = c + 2 * side + 4
        for (let b = 0; b < 16; b++) {
          const th = Math.PI * (0.1 + (0.8 * b) / 15)
          const x = a.x + Math.cos(th) * d
          const y = a.y + Math.sin(th) * d
          if (Math.hypot(x - a.x, y - a.y) - side * 1.5 <= c + 1) continue
          if (!solidBox(x, y, side + 1)) continue
          out.push({ x: a.x, y: a.y, r: a.r, c, side, cx: x, cy: y, above: a.y - a.r - 3 * bodyH })
          return
        }
      })
      out.sort((p, q) => q.c - p.c)
      return { rocks: rocks.length, discs: flat.length / 3, best: out[0] ?? null }
    },
    [k.VIEWPORT_W / 2 / k.CAMERA_ZOOM, k.VIEWPORT_H / 2 / k.CAMERA_ZOOM, k.PLAYER_H],
  )
  if (pick.rocks === 0) {
    throw new Error('the sandbox map has no asteroids — `?gravity=space` did not reach the scene')
  }
  if (pick.discs !== pick.rocks) {
    throw new Error(`coreDiscs gave ${pick.discs} discs for ${pick.rocks} rocks`)
  }
  const rock = pick.best
  if (!rock) throw new Error('no rock with a photographable core and a solid body patch on this map')
  log(`rock (${rock.x}, ${rock.y}) r ${rock.r}, core ${rock.c} px; control at (${rock.cx.toFixed(0)}, ${rock.cy.toFixed(0)})`)

  // The body well above the rock, out of its band (it floats still), and in sight of
  // it — the lightmap is centred on it. The camera on the core; the sky pinned.
  await page.evaluate(([x, y]) => window.__game.place(x, y), [rock.x, rock.above])
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [rock.x, rock.y])
  await page.evaluate(() => {
    window.__game.setTime(0)
    window.__game.setParallaxClock(0)
  })
  // Aim straight up, so the crosshair rides above the body, away from the rock.
  {
    const body = await toScreen(page, rock.x, rock.above)
    await page.mouse.move(Math.max(1, Math.min(1279, Math.round(body.x))), 1)
  }
  await frames(SETTLE_FRAMES)

  const patches = async () => {
    const at = await toScreen(page, rock.x, rock.y)
    const ctl = await toScreen(page, rock.cx, rock.cy)
    if (!at.onScreen || !ctl.onScreen) throw new Error('the rock is not on screen where the camera was held')
    const side = Math.max(2, Math.round(rock.side * at.scale))
    const rect = (p) => ({ x: Math.round(p.x - side / 2), y: Math.round(p.y - side / 2), w: side, h: side })
    return { subject: rect(at), control: rect(ctl) }
  }
  const p = await patches()
  log(`patches ${JSON.stringify(p)}`)

  const warmth = (s) => s.r - s.b
  const subjectA = await samplePatch(page, p.subject)
  const controlA = await samplePatch(page, p.control)
  await shot(`asteroid-cores-intact${tag}`)
  const fmt = (s) => `rgb(${s.r.toFixed(0)}, ${s.g.toFixed(0)}, ${s.b.toFixed(0)})`
  log(`intact: core ${fmt(subjectA)}, rock body ${fmt(controlA)}`)
  const distinct = colourDelta(subjectA, controlA)
  if (distinct < DISTINCT_MIN) {
    throw new Error(
      `the core's centre ${fmt(subjectA)} is only ${distinct.toFixed(1)} from the rock body ` +
        `${fmt(controlA)} (need ${DISTINCT_MIN}) — no distinct core is drawn`,
    )
  }
  if (warmth(subjectA) - warmth(controlA) < WARM_MIN) {
    throw new Error(
      `the core's centre ${fmt(subjectA)} is not the core's warm colour against the rock ` +
        `${fmt(controlA)} (red−blue ${warmth(subjectA).toFixed(0)} vs ${warmth(controlA).toFixed(0)})`,
    )
  }

  // The control frame: the core carved away on the client's core — what the server's
  // crumble carve does — and the rebake reaching the screen.
  await page.evaluate(([x, y, c]) => window.__game.core.carve(x, y, c), [rock.x, rock.y, rock.c])
  await frames(SETTLE_FRAMES)
  const p2 = await patches()
  if (JSON.stringify(p2) !== JSON.stringify(p)) throw new Error('the camera moved between the two frames')
  const subjectB = await samplePatch(page, p.subject)
  const controlB = await samplePatch(page, p.control)
  await shot(`asteroid-cores-carved${tag}`)
  log(`carved: centre ${fmt(subjectB)}, rock body ${fmt(controlB)}`)
  if (colourDelta(subjectB, subjectA) < DISTINCT_MIN || warmth(subjectB) - warmth(controlB) >= WARM_MIN) {
    throw new Error(
      `carved away, the core's centre still reads ${fmt(subjectB)} (was ${fmt(subjectA)}) — the ` +
        'colour did not go with the pixels',
    )
  }
  const moved = colourDelta(controlB, controlA)
  if (moved > UNCHANGED_MAX) {
    throw new Error(
      `the control region moved ${moved.toFixed(1)} between the frames (${fmt(controlA)} → ` +
        `${fmt(controlB)}) — the difference at the core is not the core's alone`,
    )
  }
}
