/**
 * `leaves` — T23.08B: the foreground leaves in a live scene (the sandbox; the match runs the same code, `GameScene`).
 *
 * 1. **The map has its own clusters and the frame draws the ones in view** — counted at both ends: the clusters that
 *    reach into the drawn view (`__world.view()`, grown by each one's reach, `leaves.ts::LEAF_REACH`) against how many
 *    the renderer handed the shader (`leaves().shown`), at least one on this seed; and the leaves are **there in the
 *    picture** — their own alpha over the nearest cluster's centre ≥ `FG_PRESENT`, and the frame there differs from
 *    the same frame with the layer hidden (`hideLayers(['fg'])`, the control).
 * 2. **The scene hands over its player** — `atmosphere().occluders` is exactly one box, and it contains the body.
 * 3. **A leaf never hides a player** — one cluster planted on the body (`setLeaves`) leaves its box at alpha ≤
 *    `FG_MAX_ALPHA`; the same cluster planted `AWAY` px to the side, where nobody stands, covers its box ≥ `FG_PRESENT`
 *    (the must-fail control: a fade that faded everything would pass the first half).
 */
const FG_MAX_ALPHA = 0.25
const FG_PRESENT = 0.8
/** A cluster's reach in radii — `leaves.ts::LEAF_REACH`. */
const LEAF_REACH = 1.75
/** The planted control cluster's offset from the body, mask px: clear of the player's box and of the fade's 24 px ease. */
const AWAY = 400
/** A pixel moved past this per channel when the layer is hidden (0–255). */
const MOVED = 6

const frames = (page, n = 3) => page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) }), n)

export default async function ({ page, shot, log }) {
  const problems = []
  await page.waitForFunction(() => window.__game && window.__world && window.__world.litTerrain()?.drawn && !window.__game.debug().terrainSwapPending, null, { timeout: 120_000 })
  await page.evaluate(() => window.__game.freeze(true))
  await frames(page)

  // ------------------------------------------------------------------ 1. clusters, shown, drawn
  const st = await page.evaluate(() => ({ leaves: window.__world.leaves(), view: window.__world.view(), atmos: window.__world.atmosphere() }))
  const { clusters, shown } = st.leaves ?? { clusters: [], shown: -1 }
  const v = st.view
  const inView = clusters.filter((s) => {
    const r = s.r * LEAF_REACH
    return s.x + r > v.x && s.x - r < v.x + v.w && s.y + r > v.y && s.y - r < v.y + v.h
  })
  log(`1. ${clusters.length} clusters on this map; ${inView.length} reach into the view ${JSON.stringify(v)}, the renderer handed the shader ${shown}`)
  if (!(clusters.length > 0)) problems.push('the map has no leaf clusters')
  if (shown !== Math.min(6, inView.length)) problems.push(`the shader got ${shown} clusters, ${inView.length} reach into the view (max 6)`)
  if (!(inView.length > 0)) problems.push('no cluster reaches into the spawn view on this seed — the presence leg photographs nothing')
  if (!st.atmos?.fg) problems.push(`the foreground layer is not drawn: ${JSON.stringify(st.atmos)}`)
  if (inView.length > 0) {
    const cx = v.x + v.w / 2
    const cy = v.y + v.h / 2
    const near = inView.reduce((a, b) => ((a.x - cx) ** 2 + (a.y - cy) ** 2 <= (b.x - cx) ** 2 + (b.y - cy) ** 2 ? a : b))
    const q = near.r / 3
    const box = [near.x - q, near.y - q, near.x + q, near.y + q]
    const a = await page.evaluate((b) => window.__world.foregroundAlpha(b), box)
    const read = () => page.evaluate(() => window.__world.readFrame())
    const on = await read()
    await page.evaluate(() => window.__world.hideLayers(['fg']))
    await frames(page)
    const off = await read()
    await page.evaluate(() => window.__world.hideLayers([]))
    await frames(page)
    // The box in buffer px (rows top-down in readFrame's copy), the same mapping both frames share.
    const toBuf = (mx, my) => [Math.round(((mx - on.view.x) / on.view.w) * on.w), Math.round(((my - on.view.y) / on.view.h) * on.h)]
    const [bx0, by0] = toBuf(box[0], box[1])
    const [bx1, by1] = toBuf(box[2], box[3])
    const A = Buffer.from(on.rgba, 'base64')
    const B = Buffer.from(off.rgba, 'base64')
    let moved = 0
    let n = 0
    for (let y = Math.max(0, by0); y < Math.min(on.h, by1); y++) {
      for (let x = Math.max(0, bx0); x < Math.min(on.w, bx1); x++) {
        const i = (y * on.w + x) * 4
        n++
        if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) > MOVED) moved++
      }
    }
    log(`   nearest cluster ${JSON.stringify(near)}: leaf alpha max ${a?.max.toFixed(3)} mean ${a?.mean.toFixed(3)} (≥ ${FG_PRESENT}); ${moved}/${n} px move when the layer is hidden`)
    if (!a || !(a.max >= FG_PRESENT)) problems.push(`no leaves drawn over the nearest cluster (alpha ${a?.max})`)
    if (!(n > 0 && moved / n > 0.25)) problems.push(`hiding the leaves changes ${moved}/${n} px of the cluster's box — they are not in the picture`)
    await shot('leaves-sandbox')
  }

  // ------------------------------------------------------------------ 2. the scene's occluders
  const body = await page.evaluate(() => window.__game.debug().player)
  const occ = st.atmos?.occluders ?? []
  log(`2. the scene handed over ${occ.length} player box(es): ${JSON.stringify(occ)}; the body at (${body?.x?.toFixed(1)}, ${body?.y?.toFixed(1)})`)
  if (occ.length !== 1) problems.push(`the sandbox draws one player; the renderer got ${occ.length} boxes`)
  else if (!(body && body.x > occ[0][0] && body.x < occ[0][2] && body.y > occ[0][1] && body.y < occ[0][3])) problems.push(`the box ${JSON.stringify(occ[0])} does not contain the body`)

  // ------------------------------------------------------------------ 3. a cluster planted on the body, and beside it
  if (occ.length === 1 && body) {
    const plant = async (dx) => {
      await page.evaluate((s) => window.__world.setLeaves([s]), { x: Math.round(body.x + dx), y: Math.round(body.y), r: 110, n: 10 })
      await frames(page)
      const b = occ[0]
      return page.evaluate((b) => window.__world.foregroundAlpha(b), [b[0] + dx, b[1], b[2] + dx, b[3]])
    }
    const over = await plant(0)
    await shot('leaves-over-player')
    const away = await plant(AWAY)
    log(`3. a cluster on the player: alpha max ${over?.max.toFixed(3)} over its box (≤ ${FG_MAX_ALPHA}); the same cluster ${AWAY} px aside: ${away?.max.toFixed(3)} over the same-sized box (≥ ${FG_PRESENT}, control)`)
    if (!over || !(over.max <= FG_MAX_ALPHA)) problems.push(`a leaf over the player reaches alpha ${over?.max} (max ${FG_MAX_ALPHA})`)
    if (!away || !(away.max >= FG_PRESENT)) problems.push(`control: the cluster with nobody under it covers its box only to ${away?.max} — the fade leg cannot fail`)
  }

  if (problems.length) throw new Error(problems.join('\n'))
}
