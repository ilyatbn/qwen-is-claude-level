/**
 * `look-lab` — T23.01 step 3: `?look=F1` … `?look=F5` builds each reference scene's
 * description and hands it to the world renderer, driven by Phaser's camera.
 *
 * Asserted, per scene, **at both ends of the hand-over**: what the page built from the ported
 * data (`__look.described`) against what the renderer received (`__look.rendered`) — actors,
 * lights, fx, labels and the mask's rock pixel count — and the view the renderer was asked to
 * draw (Phaser's `worldView`) against the scene's own camera rect. `ready` must mean a frame
 * was drawn: `frames ≥ 1`.
 *
 * Control: an unknown scene id must be reported by name and **never** become ready — a page
 * that set `ready` unconditionally would pass every positive assertion above.
 */
const SCENES = ['F1', 'F2', 'F3', 'F4', 'F5']

export default async function ({ page, shot, log }) {
  const base = new URL(page.url())
  const open = async (id) => {
    base.search = `?look=${id}`
    await page.goto(base.href, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error), null, {
      timeout: 60_000,
    })
    return page.evaluate(() => JSON.parse(JSON.stringify(window.__look)))
  }

  for (const id of SCENES) {
    const h = await open(id)
    const fail = (what) => {
      throw new Error(`look-lab ${id}: ${what} (${JSON.stringify(h)})`)
    }
    if (h.error) fail(`the page reported an error: ${h.error}`)
    if (JSON.stringify(h.available) !== JSON.stringify(SCENES)) fail(`the lab offers ${h.available}, want ${SCENES}`)
    if (!h.ready || !(h.frames >= 1)) fail(`not ready after a drawn frame (frames ${h.frames})`)
    if (!h.backend) fail('no renderer backend named')
    const d = h.described
    const r = h.rendered
    if (!d || !r) fail('the description or the renderer’s copy is missing')
    for (const k of ['id', 'actors', 'lights', 'fx', 'labels', 'solidPx']) {
      if (d[k] !== r[k]) fail(`${k}: the page built ${d[k]}, the renderer received ${r[k]}`)
    }
    if (d.id !== id) fail(`the page described ${d.id}`)
    if (!(d.actors > 0 && d.lights > 0 && d.solidPx > 0)) fail('an empty scene: no actors, lights or rock')
    const c = h.camera
    const v = h.view
    if (!v || v.x !== c.x || v.y !== c.y || v.w !== c.w || v.h !== c.h) {
      fail(`the renderer was asked for view ${JSON.stringify(v)}, the scene's camera is ${JSON.stringify(c)}`)
    }
    log(`${id}: ${h.backend}, ${h.frames} frame(s), ${d.actors} actors, ${d.lights} lights, ${d.fx} fx, ${d.solidPx} rock px, view ${v.w}x${v.h}`)
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
}
