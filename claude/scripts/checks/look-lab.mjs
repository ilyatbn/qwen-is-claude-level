/**
 * `look-lab` — T23.01 step 3: `?look=F1` … `?look=F5` builds each reference scene's
 * description and hands it to the world renderer, driven by Phaser's camera.
 *
 * Asserted, per scene, **at both ends of the hand-over**: what the page built from the ported
 * data (`__look.described`) against what the renderer received (`__look.rendered`) — actors,
 * lights, fx, labels and the mask's rock pixel count — and the view the renderer was asked to
 * draw (Phaser's `worldView`) against the scene's own camera rect. `ready` must mean a frame
 * was drawn: `frames ≥ 1`. T23.02: the actor boxes the page describes are the ones
 * `look-compare` paints as its `actors` region (`actorBoxes(id)`), one per actor.
 *
 * Control: an unknown scene id must be reported by name and **never** become ready — a page
 * that set `ready` unconditionally would pass every positive assertion above.
 *
 * T23.03B: **the backend must be three.js.** `createWorldRenderer` falls back to the draw-nothing
 * `StubRenderer` where three cannot start, and the stub counts frames and scenes exactly as the
 * real one does — so every assertion above passed on it. Control: `&world=off` (the stub, on
 * the dev surface) must fail this check **by name**.
 */
import { actorBoxes } from '../lib/look-compare.mjs'

// T23.14: F7, the pose sheet (the stick figure's Level A, `stick-figure`).
const SCENES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F7']
const STUB_REASON = (b) => `the world renderer is "${b}", not three.js — the stub draws nothing`

/** The first thing wrong with scene `id`'s handle `h`, or `null`. */
function verify(h, id) {
  if (h.error) return `the page reported an error: ${h.error}`
  if (JSON.stringify(h.available) !== JSON.stringify(SCENES)) return `the lab offers ${h.available}, want ${SCENES}`
  if (!h.ready || !(h.frames >= 1)) return `not ready after a drawn frame (frames ${h.frames})`
  if (h.backend !== 'three') return STUB_REASON(h.backend)
  const d = h.described
  const r = h.rendered
  if (!d || !r) return 'the description or the renderer’s copy is missing'
  for (const k of ['id', 'actors', 'lights', 'fx', 'labels', 'solidPx']) {
    if (d[k] !== r[k]) return `${k}: the page built ${d[k]}, the renderer received ${r[k]}`
  }
  if (d.id !== id) return `the page described ${d.id}`
  if (!(d.actors > 0 && d.lights > 0 && d.solidPx > 0)) return 'an empty scene: no actors, lights or rock'
  const c = h.camera
  const v = h.view
  if (!v || v.x !== c.x || v.y !== c.y || v.w !== c.w || v.h !== c.h) {
    return `the renderer was asked for view ${JSON.stringify(v)}, the scene's camera is ${JSON.stringify(c)}`
  }
  // T23.02: the actor region look-compare paints is the one this scene describes.
  const want = JSON.stringify(actorBoxes(id))
  if (JSON.stringify(h.actorBoxes) !== want) return `actor boxes differ from look-compare's: ${JSON.stringify(h.actorBoxes)} vs ${want}`
  if (h.actorBoxes.length !== d.actors) return `${h.actorBoxes.length} actor boxes for ${d.actors} actors`
  return null
}

export default async function ({ page, shot, log }) {
  const base = new URL(page.url())
  const open = async (id, extra = '') => {
    base.search = `?look=${id}${extra}`
    await page.goto(base.href, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error), null, {
      timeout: 60_000,
    })
    return page.evaluate(() => JSON.parse(JSON.stringify(window.__look)))
  }

  for (const id of SCENES) {
    const h = await open(id)
    const why = verify(h, id)
    if (why) throw new Error(`look-lab ${id}: ${why} (${JSON.stringify(h)})`)
    const d = h.described
    log(`${id}: ${h.backend}, ${h.frames} frame(s), ${d.actors} actors, ${d.lights} lights, ${d.fx} fx, ${d.solidPx} rock px, view ${h.view.w}x${h.view.h}`)
    await shot(`look-lab-${id}`)
  }

  // --- the control: an unknown id fails by name and never becomes ready ---------------
  const bad = await open('F9')
  // Give it frames in which to (wrongly) turn ready.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  const after = await page.evaluate(() => ({ ready: window.__look.ready, error: window.__look.error }))
  if (after.ready || !/F9/.test(bad.error ?? '')) {
    throw new Error(`look-lab control: ?look=F9 should report "F9" and stay not-ready, got ${JSON.stringify(after)}`)
  }
  log(`control: ?look=F9 -> ${after.error}`)

  // --- the control: the stub renderer fails the backend assertion by name ----------------
  const stub = await open('F1', '&world=off')
  const got = verify(stub, 'F1')
  if (got !== STUB_REASON('stub')) {
    throw new Error(`look-lab control: with the stub (&world=off) the check reported ${JSON.stringify(got)}, want "${STUB_REASON('stub')}"`)
  }
  log(`control: ?look=F1&world=off fails by name -> "${got}"`)
}
