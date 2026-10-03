/**
 * `leaves` — T23.43: the foreground leaves are **tiny dark flecks drifting across the screen** (`look/leafFlecks.ts`),
 * not T23.08B's big clusters, in a live scene (the sandbox; the match runs the same code, `GameScene`).
 *
 * 1. **A few dozen in view, and the big clusters gone** — counted at the renderer (`__world.flecks().drawn`) between
 *    `FEW` and `MANY`; the old cluster layer (`atmosphere().fg`) is not drawn.
 * 2. **They are in the picture, and every one is small** — the frame with the flecks against the same frozen frame with
 *    them hidden (`hideLayers(['leaves'])`): the px that change form separate specks, at least a third as many as the
 *    renderer drew (a dark fleck over dark rock may not move a px past `MOVED`), and **no speck is wider or taller than
 *    `FLECK_MAX_PX`** (read from `leafFlecks.ts`) plus `EDGE_PX` of antialiased edge. Controls: the frame drawn twice
 *    with the flecks shown is identical (the clock is held, so a difference is the layer, not drift), and the frame
 *    drawn twice with them hidden is identical.
 * 3. **The scene hands over its player** — the flecks fade over the boxes `flecks().occluders`: exactly one, holding the body.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** "A few dozen" on screen, the owner's ask — the bounds the count must fall in. */
const FEW = 12
const MANY = 80
/** A px moved past this per channel when the layer is hidden (0–255). */
const MOVED = 3
/** The antialiased edge a speck may carry past the fleck's own length, buffer px. */
const EDGE_PX = 2

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const src = readFileSync(join(root, 'client/src/look/leafFlecks.ts'), 'utf8')
const lenDecl = /export const FLECK_LEN: readonly \[number, number\] = \[([0-9.]+), ([0-9.]+)\]/.exec(src)
if (!lenDecl) throw new Error('leafFlecks.ts has no `FLECK_LEN` — the size bound below would read nothing')
/** `leafFlecks.ts::FLECK_MAX_PX` (= `FLECK_LEN[1]`). */
const FLECK_MAX_PX = Number(lenDecl[2])

const frames = (page, n = 3) => page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) }), n)

/** Changed px between two `readFrame`s (same size), as connected specks: each one's px count and box, buffer px. */
function specks(A, B, w, h) {
  const moved = new Uint8Array(w * h)
  let changed = 0
  for (let i = 0; i < w * h; i++) {
    const j = i * 4
    if (Math.max(Math.abs(A[j] - B[j]), Math.abs(A[j + 1] - B[j + 1]), Math.abs(A[j + 2] - B[j + 2])) > MOVED) {
      moved[i] = 1
      changed++
    }
  }
  const out = []
  const stack = []
  for (let i = 0; i < w * h; i++) {
    if (moved[i] !== 1) continue
    let n = 0
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    moved[i] = 2
    stack.push(i)
    while (stack.length) {
      const k = stack.pop()
      const x = k % w
      const y = (k - x) / w
      n++
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const q = yy * w + xx
        if (moved[q] === 1) { moved[q] = 2; stack.push(q) }
      }
    }
    out.push({ n, w: x1 - x0 + 1, h: y1 - y0 + 1, x: x0, y: y0 })
  }
  return { changed, list: out }
}

export default async function ({ page, shot, log }) {
  const problems = []
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn && !window.__game.debug().terrainSwapPending, null, { timeout: 120_000 })
  await page.evaluate(() => window.__game.freeze(true))
  await frames(page)

  // ------------------------------------------------------------------ 1. a few dozen, and no clusters
  const st = await page.evaluate(() => ({ flecks: window.__world.flecks(), atmos: window.__world.atmosphere() }))
  const drawn = st.flecks?.drawn ?? []
  log(`1. ${drawn.length} flecks drawn (want ${FEW}–${MANY}); the cluster layer drawn: ${st.atmos?.fg}`)
  if (!st.flecks?.on) problems.push('the scene has no leaf flecks (`desc.leafFlecks` unset on a classic map)')
  if (!(drawn.length >= FEW && drawn.length <= MANY)) problems.push(`${drawn.length} flecks on screen — not a few dozen (${FEW}–${MANY})`)
  if (st.atmos?.fg !== false) problems.push(`the big leaf clusters are still drawn (atmosphere().fg = ${st.atmos?.fg})`)
  const longest = Math.max(0, ...drawn.map((d) => d.len))
  if (!(longest <= FLECK_MAX_PX)) problems.push(`the renderer laid out a fleck ${longest} px long (max ${FLECK_MAX_PX})`)

  // ------------------------------------------------------------------ 2. in the picture, and small
  const read = async () => {
    await frames(page)
    return page.evaluate(() => window.__world.readFrame())
  }
  const on = await read()
  const on2 = await read()
  await page.evaluate(() => window.__world.hideLayers(['leaves']))
  const off = await read()
  const off2 = await read()
  await page.evaluate(() => window.__world.hideLayers([]))
  await frames(page)
  const buf = (f) => Buffer.from(f.rgba, 'base64')
  const [A, A2, B, B2] = [on, on2, off, off2].map(buf)
  const stillOn = specks(A, A2, on.w, on.h).changed
  const stillOff = specks(B, B2, on.w, on.h).changed
  const sp = specks(A, B, on.w, on.h)
  // Buffer px per mask px (the low tier draws at half resolution): the bound is the fleck's length on this buffer.
  const scale = on.w / on.view.w
  const bound = FLECK_MAX_PX * scale + EDGE_PX
  // Two flecks that happen to touch make one speck: one holding two drawn centres may be up to twice the bound.
  const centres = drawn.map((d) => [(d.x - on.view.x) * scale, (d.y - on.view.y) * (on.h / on.view.h)])
  const holds = (s) => centres.filter(([x, y]) => x >= s.x - EDGE_PX && x <= s.x + s.w + EDGE_PX && y >= s.y - EDGE_PX && y <= s.y + s.h + EDGE_PX).length
  const big = sp.list.filter((s) => (s.w > bound || s.h > bound) && !(holds(s) >= 2 && s.w <= 2 * bound && s.h <= 2 * bound))
  const widest = sp.list.reduce((m, s) => Math.max(m, s.w, s.h), 0)
  log(`2. hiding the flecks moves ${sp.changed} px in ${sp.list.length} specks (want ≥ ${Math.ceil(drawn.length / 3)}); the widest ${widest} px (max ${bound.toFixed(1)} at ${scale.toFixed(2)} buffer px per mask px); controls — shown twice: ${stillOn} px differ, hidden twice: ${stillOff}`)
  if (stillOn !== 0) problems.push(`control: the frame with the flecks drawn twice differs in ${stillOn} px — the clock is not held, so nothing below is about the layer`)
  if (stillOff !== 0) problems.push(`control: the frame with the flecks hidden drawn twice differs in ${stillOff} px`)
  if (!(sp.list.length >= drawn.length / 3)) problems.push(`hiding ${drawn.length} flecks changes only ${sp.list.length} specks — they are not in the picture`)
  if (big.length) problems.push(`${big.length} specks are bigger than a fleck (${bound.toFixed(1)} px): ${JSON.stringify(big.slice(0, 5))}`)
  await shot('leaves-flecks')

  // ------------------------------------------------------------------ 3. the scene's occluders
  const body = await page.evaluate(() => window.__game.debug().player)
  const occ = (await page.evaluate(() => window.__world.flecks()))?.occluders ?? []
  log(`3. the flecks faded over ${occ.length} player box(es): ${JSON.stringify(occ)}; the body at (${body?.x?.toFixed(1)}, ${body?.y?.toFixed(1)})`)
  if (occ.length !== 1) problems.push(`the sandbox draws one player; the flecks got ${occ.length} boxes`)
  else if (!(body && body.x > occ[0][0] && body.x < occ[0][2] && body.y > occ[0][1] && body.y < occ[0][3])) problems.push(`the box ${JSON.stringify(occ[0])} does not contain the body`)

  if (problems.length) throw new Error(problems.join('\n'))
}
