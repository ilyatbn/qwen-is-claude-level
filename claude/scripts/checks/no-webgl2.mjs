/**
 * `no-webgl2` — T23.04C F8: the picture a machine without WebGL2 gets.
 *
 * `REQUIRE_WEBGL2` is still false (`webgl2.ts`): without WebGL2 the game boots, Phaser falls back to
 * WebGL1, and the world renderer falls back to the draw-nothing stub (`createWorldRenderer`). Nothing
 * measured that path: the review forced it by hand and found it booted, with three's
 * `console.error` on every scene start. Here `getContext('webgl2')` is forced to return null before
 * any page script runs, and:
 *
 * 1. **The title and the sandbox boot on the stub** — `__world.backend` is `stub` in each scene,
 *    the title's backdrop guard is live, the sandbox's Phaser frames advance.
 * 2. **No page errors, and no console errors** (three's "Error creating WebGL context" was one per
 *    scene; since R22 the world canvas asks for the context itself and warns once, plainly).
 * 3. **A known flat sky**: wherever Phaser draws nothing (its alpha read back, 0) and nothing of the
 *    DOM sits on top, the screenshot is the page's own `#0b1020` — not black, not a half-drawn
 *    world canvas. **Control:** the same measurement on this title *with* WebGL2 must not be flat
 *    (the three.js sky shows there), or the comparison could not fail.
 */
const PAGE_BG = [0x0b, 0x10, 0x20]
/** Channel tolerance against the page colour: the screenshot's 8-bit path. */
const TOL = 1
/** Points that must be measured for the verdict to mean anything. */
const MIN_POINTS = 20
/** Clearance from the DOM's text and controls, CSS px: the title's glow (text-shadow) reaches past its box. */
const PAD = 24

/** Before any page script: no WebGL2 context, as on a machine without it. */
function noWebgl2() {
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (type === 'webgl2') return null
    return orig.call(this, type, ...rest)
  }
}

/** Points where Phaser's canvas is transparent and on top: what shows there is what is under it. */
async function clearPoints(page) {
  const { W, H } = await page.evaluate(() => ({ W: innerWidth, H: innerHeight }))
  const grid = []
  for (let y = 15; y < H; y += 45) for (let x = 15; x < W; x += 60) grid.push([x, y])
  const alpha = await page.evaluate((pts) => window.__world.phaserAlpha(pts), grid)
  if (!alpha) throw new Error("Phaser's alpha could not be read back (no WebGL on Phaser's canvas)")
  // On Phaser's canvas, and clear of the DOM's text and controls by `PAD` (the title's lettering is
  // `pointer-events: none`, so `elementFromPoint` sees through it, and its glow reaches past its box).
  const onCanvas = await page.evaluate(
    ([pts, pad]) => {
      const phaser = document.querySelector('#game canvas:not([data-world])')
      const boxes = [...document.body.querySelectorAll('*')]
        .filter((e) => !e.closest('#game') && ([...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || /^(BUTTON|INPUT|SELECT)$/.test(e.tagName)))
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
      const near = (x, y) => boxes.some((r) => x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad)
      return pts.map(([x, y]) => document.elementFromPoint(x, y) === phaser && !near(x, y))
    },
    [grid, PAD],
  )
  return grid.filter((_, i) => alpha[i] === 0 && onCanvas[i])
}

async function screenPixels(page, points) {
  const b64 = (await page.screenshot()).toString('base64')
  return page.evaluate(
    async ([b, pts]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const c = cv.getContext('2d')
      c.drawImage(img, 0, 0)
      return pts.map(([x, y]) => [...c.getImageData(x, y, 1, 1).data.slice(0, 3)])
    },
    [b64, points],
  )
}

/** How many of the Phaser-transparent points show exactly the page colour. */
async function flatness(page) {
  const pts = await clearPoints(page)
  const px = await screenPixels(page, pts)
  const isFlat = (p) => p.every((v, i) => Math.abs(v - PAGE_BG[i]) <= TOL)
  const flat = px.filter(isFlat).length
  const off = pts.map((pt, i) => [pt, px[i]]).filter(([, p]) => !isFlat(p))
  return { n: pts.length, flat, sample: px.slice(0, 3), off: off.slice(0, 4) }
}

const titleReady = (page) =>
  page.waitForFunction(() => !!window.__title && window.__title.debug().frames > 2 && window.__world?.scene === 'Title', null, { timeout: 60_000 })

export default async function ({ page, shot, log }) {
  const problems = []
  const base = new URL(page.url())

  // Control: the title with WebGL2 — the world canvas's sky shows, so it is not flat.
  await titleReady(page)
  await page.evaluate(() => window.__world.readFrame())
  const withGl = await flatness(page)
  log(`control, with WebGL2: backend ${await page.evaluate(() => window.__world.backend)}; ${withGl.flat}/${withGl.n} Phaser-clear points are the flat page colour`)
  if (withGl.n < MIN_POINTS) problems.push(`control: only ${withGl.n} Phaser-clear points on the title`)
  if (withGl.flat > withGl.n / 2) problems.push(`control: with WebGL2 ${withGl.flat}/${withGl.n} points are the flat page colour — the measurement cannot tell a sky from none`)

  // Without WebGL2, from here on.
  await page.context().addInitScript(noWebgl2)
  const errors = []
  const consoleErrors = []
  const warnings = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
    if (m.type() === 'warning' && /WebGL2|WorldRenderer/.test(m.text())) warnings.push(m.text())
  })

  for (const [where, search] of [['title', '?e2e=1'], ['sandbox', '?e2e=1&sandbox=1&seed=4242']]) {
    base.search = search
    await page.goto(base.href, { waitUntil: 'load' })
    if (where === 'title') await titleReady(page)
    else await page.waitForFunction(() => !!window.__game && window.__world?.scene === 'Sandbox', null, { timeout: 60_000 })
    const state = await page.evaluate(() => ({
      webgl2: !!document.createElement('canvas').getContext('webgl2'),
      backend: window.__world.backend,
      title: window.__title?.debug() ?? null,
    }))
    const f0 = await page.evaluate(() => window.__world.frames())
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))))
    const f1 = await page.evaluate(() => window.__world.frames())
    const flat = await flatness(page)
    await shot(`no-webgl2-${where}`)
    log(`${where} without WebGL2: getContext('webgl2') ${state.webgl2 ? 'answered' : 'null'}; backend ${state.backend}; scene frames ${f0} → ${f1}; ${flat.flat}/${flat.n} Phaser-clear points are the page colour ${JSON.stringify(PAGE_BG)} (e.g. ${JSON.stringify(flat.sample)})`)
    if (state.webgl2) problems.push(`${where}: the forced-off WebGL2 still answered — the check is not measuring the fallback`)
    if (state.backend !== 'stub') problems.push(`${where}: the world renderer is "${state.backend}", want the stub`)
    if (where === 'title' && !(state.title?.backdropOk && state.title?.drawOk)) problems.push(`title: a guard tripped without WebGL2: ${JSON.stringify(state.title)}`)
    if (!(f1 > f0)) problems.push(`${where}: the scene stopped drawing (${f0} → ${f1} frames)`)
    if (flat.n < MIN_POINTS) problems.push(`${where}: only ${flat.n} Phaser-clear points to measure`)
    else if (flat.flat !== flat.n) problems.push(`${where}: ${flat.n - flat.flat}/${flat.n} Phaser-clear points are not the page colour: ${JSON.stringify(flat.off)}`)
  }
  log(`warnings: ${warnings.length} (${[...new Set(warnings.map((w) => w.slice(0, 90)))].join(' | ')})`)
  if (errors.length) problems.push(`page errors: ${errors.slice(0, 3).join(' | ')}`)
  if (consoleErrors.length) problems.push(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`)
  if (problems.length) throw new Error(`no-webgl2:\n  - ${problems.join('\n  - ')}`)
}
