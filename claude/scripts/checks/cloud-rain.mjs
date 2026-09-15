/**
 * T21.31 B — rain falls from clouds, in the world, and stops at the ground.
 *
 * Reported from play: *"it literally rains from the whole screen when the clouds are
 * below me.. its just terrible."* The ambient sheet was `scrollFactor(0)`: it covered
 * the viewport wherever the camera was — above the sky, over rock, inside caves.
 *
 * ## Every drawn drop must be licensed
 *
 * One frozen frame is photographed with the ambient rain shown and hidden; every pixel
 * that differs is mapped back to the world and must be **licensed**:
 *
 * - **under a cloud** — inside a placed cloud's x-range, and no higher than the lower
 *   part of that cloud (`AMBIENT_RAIN_SPAWN_DEPTH`), so none falls above a cloud;
 * - **not below its column's first rock**, so none is in the ground or a cave.
 *
 * The cloud clock is pinned, so the clouds do not move while a drop falls and the
 * licence needs no slack beyond the stroke.
 *
 * Three frames: **under a cloud** — the presence control, where licensed pixels must
 * clear a floor; **above the clouds**; **inside a cave**. An absence in the last two
 * would be satisfied by a rain that never draws, which the first frame rules out, and
 * the cave frame also reads that the rain is still falling somewhere while it is shot.
 */

/** Per-channel change that counts a pixel as changed. */
const THRESH = 8
/** Licensed pixels the under-a-cloud frame must show — a few drops' worth. */
const PRESENCE_FLOOR = 150

export default async function ({ page, shot, log }) {
  const g = (fn, arg) => page.evaluate(fn, arg)
  await g(() => window.__game.regenerate('4242', 'medium'))
  await page.waitForTimeout(700)
  await g(() => {
    window.__game.setTime(0.3 * 120)
    window.__game.setParallaxClock(0)
    window.__game.forceAmbient(1)
  })
  const k = await g(() => window.__game.constants())

  const waitStill = async () => {
    let last = null
    let still = 0
    const deadline = Date.now() + 15_000
    while (still < 3) {
      if (Date.now() > deadline) throw new Error(`the camera never settled (last view ${JSON.stringify(last)})`)
      await page.waitForTimeout(200)
      const v = await g(() => window.__game.debug().worldView)
      still = last && v.x === last.x && v.y === last.y ? still + 1 : 0
      last = v
    }
    return last
  }

  /**
   * Hold the camera at a world point long enough for drops to reach the bottom of the
   * view from the highest cloud over it — derived from the fall speed, never slept
   * against a number.
   */
  const frame = async (label, x, y) => {
    await g(([wx, wy]) => window.__game.watch(wx, wy), [x, y])
    const v = await waitStill()
    const fallS = (v.h + k.CLOUD_ALTITUDE_MAX + k.CLOUD_W_MAX) / k.AMBIENT_RAIN_FALL_MIN + k.AMBIENT_RAIN_STAGGER
    await page.waitForTimeout(Math.ceil(fallS * 1000))
    await g(() => window.__game.freeze(true))
    try {
      const on = (await page.screenshot()).toString('base64')
      const again = (await page.screenshot()).toString('base64')
      const hid = await g(() => window.__game.setRainVisible('ambient', false))
      const off = (await page.screenshot()).toString('base64')
      const shown = await g(() => window.__game.setRainVisible('ambient', true))
      if (hid.visible !== false || shown.visible !== true) throw new Error('setRainVisible did not read back what it was asked')
      await shot(`cloud-rain-${label}`)
      const alive = await g(() => window.__game.debug().ambientAlive)
      const m = await g(
        async ([a64, b64, c64, thr, depth, stroke]) => {
          const load = async (src) => {
            const img = new Image()
            img.src = `data:image/png;base64,${src}`
            await img.decode()
            const cv = document.createElement('canvas')
            cv.width = img.width
            cv.height = img.height
            const c = cv.getContext('2d')
            c.drawImage(img, 0, 0)
            return c.getImageData(0, 0, img.width, img.height)
          }
          const game = window.__game
          const v = game.debug().worldView
          const r = document.querySelector('canvas').getBoundingClientRect()
          const A = await load(a64)
          const B = await load(b64)
          const C = await load(c64)
          const W = A.width
          const tops = new Map()
          const topAt = (x) => {
            if (!tops.has(x)) {
              let y = 0
              while (y < game.core.height && !game.core.solidAt(x, y)) y++
              tops.set(x, y)
            }
            return tops.get(x)
          }
          const clouds = game.cloudsAt(0).filter((b) => b.visible)
          const edge = stroke + 1
          let licensed = 0
          let aboveOrNoCloud = 0
          let inRock = 0
          let noise = 0
          const samples = []
          for (let py = Math.max(0, Math.floor(r.top)); py < Math.min(A.height, r.bottom); py++) {
            for (let px = Math.max(0, Math.floor(r.left)); px < Math.min(W, r.right); px++) {
              const i = (py * W + px) * 4
              const ch = (X, Y) =>
                Math.max(Math.abs(X.data[i] - Y.data[i]), Math.abs(X.data[i + 1] - Y.data[i + 1]), Math.abs(X.data[i + 2] - Y.data[i + 2]))
              if (ch(A, C) > thr) noise++
              if (ch(A, B) <= thr) continue
              const wx = v.x + ((px - r.left) / r.width) * v.w
              const wy = v.y + ((py - r.top) / r.height) * v.h
              // **Below the rock of every column the stroke touches**, not only the one the
              // pixel maps to. Measured: a drop falling at x 509.4 is tested against column
              // 509, and its 1.5 px stroke spills into column 510, whose rock starts higher
              // on a slope — 60 px "in rock" at one spot, every one within a stroke's width.
              let deepest = -Infinity
              for (let cx = Math.floor(wx - edge); cx <= Math.ceil(wx + edge); cx++) deepest = Math.max(deepest, topAt(cx))
              if (wy > deepest + edge) {
                inRock++
                if (samples.length < 5) samples.push({ kind: 'rock', wx: Math.round(wx), wy: Math.round(wy) })
                continue
              }
              const under = clouds.some(
                (c) => wx >= c.left - edge && wx <= c.left + c.w + edge && wy >= c.top + c.h * depth - edge,
              )
              if (under) licensed++
              else {
                aboveOrNoCloud++
                if (samples.length < 5) samples.push({ kind: 'sky', wx: Math.round(wx), wy: Math.round(wy) })
              }
            }
          }
          return { licensed, aboveOrNoCloud, inRock, noise, samples, view: { x: v.x, y: v.y, w: v.w, h: v.h } }
        },
        [on, off, again, THRESH, k.AMBIENT_RAIN_SPAWN_DEPTH, k.AMBIENT_RAIN_WIDTH],
      )
      log(
        `${label}: view ${JSON.stringify(m.view)}; licensed ${m.licensed} px, above or clear of any cloud ${m.aboveOrNoCloud}, ` +
          `in rock ${m.inRock}, noise ${m.noise}; drops falling ${alive}${m.samples.length ? `; e.g. ${JSON.stringify(m.samples)}` : ''}`,
      )
      if (m.noise > 0) throw new Error(`${label}: two photographs of one frozen frame differ in ${m.noise} px`)
      return { ...m, alive }
    } finally {
      await g(() => window.__game.freeze(false))
    }
  }

  const check = (label, m) => {
    if (m.aboveOrNoCloud > 0) throw new Error(`${label}: ${m.aboveOrNoCloud} rain pixels are above a cloud or under no cloud at all`)
    if (m.inRock > 0) throw new Error(`${label}: ${m.inRock} rain pixels are below the first rock — in the ground or a cave`)
  }

  // --- a cloud with open air under it --------------------------------------------------
  const pick = await g(() => {
    const game = window.__game
    const core = game.core
    const boxes = game.cloudsAt(0).filter((b) => b.visible).sort((a, b) => b.w - a.w)
    for (const b of boxes) {
      const x = Math.round(b.left + b.w / 2)
      let y = Math.ceil(b.top + b.h)
      while (y < core.height && !core.solidAt(x, y)) y++
      if (y - (b.top + b.h) < 400) return { ...b, ground: y }
    }
    return null
  })
  if (!pick) throw new Error('no placed cloud has ground within reach under it')
  const viewH = (await g(() => window.__game.debug().worldView)).h

  // 1. Under a cloud: the presence control.
  const under = await frame('under', pick.left + pick.w / 2, pick.top + pick.h + viewH * 0.3)
  check('under a cloud', under)
  if (under.licensed < PRESENCE_FLOOR) {
    throw new Error(`under a cloud in a forced shower only ${under.licensed} px of rain drew — nothing below is a control`)
  }

  // 2. Above the clouds: the cloud sits low in the frame, open sky over it.
  //
  // **The lowest-sitting cloud, and the sky over it measured.** The first run framed the
  // cloud picked for frame 1, which sat 40 px from the top of the world: the camera
  // clamped at y 0 and "above the clouds" was a 40 px strip — a pass that tested little.
  const low = await g(() => window.__game.cloudsAt(0).filter((b) => b.visible).sort((a, b) => b.top - a.top)[0])
  const above = await frame('above', low.left + low.w / 2, low.top - viewH * 0.25)
  const skyOver = low.top - above.view.y
  log(`above: cloud ${low.index} top at world ${low.top.toFixed(0)}, ${skyOver.toFixed(0)} px of sky over it in the frame`)
  if (skyOver < viewH * 0.3) {
    throw new Error(`the "above the clouds" frame shows only ${skyOver.toFixed(0)} px of sky over the cloud — not a frame above it`)
  }
  check('above the clouds', above)

  // 3. Inside a cave: open air with rock over it, well under the surface.
  const cave = await g(() => {
    const core = window.__game.core
    const open = (x, y) => !core.solidAt(x, y)
    for (let x = 200; x < core.width - 200; x += 24) {
      let top = 0
      while (top < core.height && !core.solidAt(x, top)) top++
      for (let y = top + 60; y < core.height - 60; y += 8) {
        let pocket = true
        for (let dy = -24; dy <= 24 && pocket; dy += 4) pocket = open(x, y + dy) && open(x - 24, y + dy) && open(x + 24, y + dy)
        if (pocket) return { x, y, roof: top }
      }
    }
    return null
  })
  if (!cave) throw new Error('seed 4242 has no cave pocket to stand the camera in')
  const inCave = await frame('cave', cave.x, cave.y)
  check('inside a cave', inCave)
  if (!(inCave.alive > 0)) throw new Error('no drop was falling anywhere while the cave was photographed — its absence proves nothing')

  await g(() => {
    window.__game.forceAmbient(null)
    window.__game.watch(null)
    window.__game.setParallaxClock(null)
    window.__game.setTime(null)
  })
}
