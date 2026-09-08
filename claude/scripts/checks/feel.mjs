/**
 * T8.08 — game feel, verified at `CAMERA_ZOOM`.
 *
 * The first attempt at this feature computed every value correctly and drew
 * nothing: a `scrollFactor(0)` Phaser object is still scaled by camera zoom, so
 * screen-space elements landed off-viewport at zoom 2 (§A35). So this check
 * asserts on **mounted DOM nodes and their screen positions**, not on the model's
 * counters — the model was right the whole time (§A15) — and it asserts those
 * positions are inside the viewport, which is the exact thing that was wrong.
 *
 * Everything here is short-lived: trauma decays at 2.5/s, the vignette in 0.55 s,
 * a damage number lives 0.9 s. So the measurement is a **poll that captures the
 * peak and snapshots the DOM while the nodes are still mounted**, not a single
 * sample at a fixed delay. Sampling after the effect has gone reads zero for a
 * feature that worked, which is a trap this project has now hit four times.
 */
export default async function ({ page, shot, log }) {
  const feel = () => page.evaluate(() => window.__game.feel())

  const zoom = await page.evaluate(() => window.__game.debug().zoom)
  log(`camera zoom ${zoom} — the value the bug was invisible at zoom 1`)
  if (zoom === 1) throw new Error('this check is meaningless at zoom 1')

  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(500)

  if ((await feel()).mountedNumbers !== 0) {
    throw new Error('damage numbers mounted before anything happened')
  }

  // A rocket at my own feet: the rocket-jump case, so the local player takes the
  // hit and the number, the vignette and the shake all fire at once.
  await page.mouse.move(640, 360 + 200)
  await page.waitForTimeout(150)
  const ev = await page.evaluate(() => window.__game.fire())
  if (ev.rejected) throw new Error(`fire rejected: ${ev.rejected}`)

  const peak = { numbers: 0, mounted: 0, vignette: 0, trauma: 0 }
  let placed = null
  let shotTaken = false

  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(50)
    const s = await page.evaluate(() => ({
      f: window.__game.feel(),
      trauma: window.__game.debug().trauma,
      nodes: [...document.querySelectorAll('[data-feel="numbers"] > div')].map((el) => {
        const r = el.getBoundingClientRect()
        return { text: el.textContent, x: Math.round(r.left), y: Math.round(r.top) }
      }),
      w: window.innerWidth,
      h: window.innerHeight,
    }))
    peak.numbers = Math.max(peak.numbers, s.f.numbers)
    peak.mounted = Math.max(peak.mounted, s.f.mountedNumbers)
    peak.vignette = Math.max(peak.vignette, s.f.vignette)
    peak.trauma = Math.max(peak.trauma, s.trauma ?? 0)
    // Snapshot the DOM *while* it is mounted, and photograph it then too — the
    // screenshot is the only way a failure is seen on this box, and a picture
    // taken after everything expired shows a clean frame either way.
    if (s.nodes.length > 0 && !placed) {
      placed = { items: s.nodes, w: s.w, h: s.h }
      if (!shotTaken) {
        await shot('feel')
        shotTaken = true
      }
    }
  }

  log(`peak over 1.3 s: ${JSON.stringify(peak)}`)

  if (peak.numbers < 1) throw new Error('the model recorded no damage number')
  if (peak.mounted < 1) {
    throw new Error('a damage number exists in the model but no DOM node was ever mounted')
  }
  if (!(peak.vignette > 0)) throw new Error('no damage vignette')
  if (!(peak.trauma > 0)) throw new Error('the explosion produced no camera trauma')

  if (!placed) throw new Error('never caught a mounted damage number to measure')
  log(`mounted: ${JSON.stringify(placed.items)} in ${placed.w}x${placed.h}`)

  // "Inside the viewport" is NOT enough, and I proved it: with the zoom dropped
  // from the mapping the number moved from (638,526) to (309,248) and stayed on
  // screen, so that assertion passed against the very bug it was written for.
  // The real claim is that the number appears *where the damage happened*, so
  // the check derives the expected position independently — from `worldView` and
  // the canvas rect, arithmetic of its own rather than the function under test —
  // and compares. That is the control.
  const expected = await page.evaluate(() => {
    const d = window.__game.debug()
    const cam = d.camera
    const view = { x: cam.x - d.visible.w / 2, y: cam.y - d.visible.h / 2, ...d.visible }
    const r = document.querySelector('canvas').getBoundingClientRect()
    const cx = ((d.player.x - view.x) / view.w) * r.width + r.left
    const cy = ((d.player.y - view.y) / view.h) * r.height + r.top
    return { x: Math.round(cx), y: Math.round(cy) }
  })
  const TOLERANCE = 140 // the number rises as it fades, and spawns at the blast
  for (const it of placed.items) {
    const dx = it.x - expected.x
    const dy = it.y - expected.y
    const off = Math.round(Math.hypot(dx, dy))
    log(`number at ${it.x},${it.y}; the blast maps to ${expected.x},${expected.y} — ${off} px away`)
    if (it.x < 0 || it.y < 0 || it.x > placed.w || it.y > placed.h) {
      throw new Error(`damage number drawn off-viewport at ${it.x},${it.y} — this is §A35 again`)
    }
    if (off > TOLERANCE) {
      throw new Error(
        `damage number is ${off} px from where the damage happened — the world→screen map is wrong (§A35)`,
      )
    }
  }

  // The banner is the other screen-space element, and it is positioned by CSS
  // rather than by the world→screen map, so it is worth its own assertion.
  await page.evaluate(() => window.__game.banner('NIGHT FALLS'))
  await page.waitForTimeout(120)
  const banner = await page.evaluate(() => {
    const el = document.querySelector('[data-feel="banner"]')
    const r = el.getBoundingClientRect()
    return {
      text: el.textContent,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      op: Number(el.style.opacity),
      vw: window.innerWidth,
    }
  })
  log(`banner: ${JSON.stringify(banner)}`)
  if (banner.text !== 'NIGHT FALLS') throw new Error('the banner did not show')
  if (banner.w <= 0) throw new Error('the banner has no width — it rendered nothing')
  if (banner.op <= 0) throw new Error('the banner is transparent')
  if (banner.x < 0 || banner.x + banner.w > banner.vw) {
    throw new Error(`the banner is off-viewport at x=${banner.x} w=${banner.w}`)
  }
  await shot('feel-banner')

  log('damage number, vignette, trauma and banner all present and on-screen at zoom 2')
}
