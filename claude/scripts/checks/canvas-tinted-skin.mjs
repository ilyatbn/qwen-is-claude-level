/**
 * `canvas-tinted-skin` — T21.37: a tinted skin is its colour on the **Canvas** renderer.
 *
 * Canvas has no sprite tint, so `setTint` left the red Recruit (a tint over the Recruit's frames)
 * drawing as the plain Recruit. The fix bakes a tinted copy of the atlas on Canvas.
 *
 * ## The assertion and its controls
 *
 * The skins are read from `assets/skins.json`, not typed: the **subject** is the first skin with a
 * tint, the **control** is the untinted skin drawn from the same frames (same atlas and prefix).
 * Both stand in **one frame**, posed identically, through `__game.showSkins`.
 *
 * - **Presence**: each body's pixels are the ones that change when the bodies are removed (the
 *   control frame). A rect with no body in it would make every number below about scenery.
 * - **Same art**: the two bodies change the same number of pixels (±15 %), or the comparison is
 *   between two different sprites and not between a tint and none.
 * - **The tint**: a multiply by `0xRRGGBB` scales R:G:B by the tint's channels, so the subject's
 *   `R / (G + B)` over its body pixels must be the control's times the tint's own ratio. The bar is
 *   half-way between "untinted" (1x) and that ratio, derived from the tint.
 * - **Drift**: two frames with nothing changed, so the fixture's own motion is measured.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function pickSkins() {
  const players = JSON.parse(readFileSync(resolve(root, 'assets/skins.json'), 'utf8')).players
  const subject = players.find((s) => s.tint)
  if (!subject) throw new Error('no skin in assets/skins.json has a tint — nothing to check')
  const control = players.find((s) => !s.tint && s.atlas === subject.atlas && s.prefix === subject.prefix)
  if (!control) throw new Error(`no untinted skin shares ${subject.name}'s frames — no control`)
  return { subject, control, tint: Number(subject.tint) }
}

export default async function ({ page, shot, log }) {
  const { subject, control, tint } = pickSkins()
  const kind = await page.evaluate(() => {
    const cv = document.querySelector('canvas')
    return { twoD: !!cv.getContext('2d'), webgl: !!cv.getContext('webgl') }
  })
  if (!kind.twoD || kind.webgl) throw new Error(`?renderer=canvas did not give a Canvas renderer: ${JSON.stringify(kind)}`)
  log(`Canvas renderer; subject ${subject.name} (id ${subject.id}, tint ${subject.tint}), control ${control.name} (id ${control.id})`)

  await page.evaluate(() => {
    const g = window.__game
    g.regenerate('4242', 'medium')
  })
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    window.__game.setTime(0.3 * 120)
    window.__game.setParallaxClock(0)
  })

  // Stand the two bodies either side of the player, clear of it and of each other, in carved air
  // so neither is lit differently by rock around it.
  const C = await page.evaluate(() => window.__game.constants())
  const placed = await page.evaluate(
    ([sid, cid, W, H]) => {
      const g = window.__game
      const d = g.debug()
      const px = d.player.x
      const py = d.player.y
      for (let wy = py - 3 * H; wy <= py + H / 2; wy += 20) {
        for (let wx = px - 8 * W; wx <= px + 8 * W; wx += 20) g.carve(Math.round(wx), Math.round(wy), 24)
      }
      const at = [
        { skin: sid, x: px - 4 * W, y: py - H },
        { skin: cid, x: px + 4 * W, y: py - H },
      ]
      return { n: g.showSkins(at), at }
    },
    [subject.id, control.id, C.PLAYER_W, C.PLAYER_H],
  )
  if (placed.n !== 2) throw new Error(`showSkins stood up ${placed.n} bodies, not 2`)
  await page.waitForTimeout(400)
  // With the bodies standing: the evaluate below removes them for its control frame.
  await shot('canvas-tinted-skin')

  const r = await page.evaluate(
    ([at, W, H, t]) => {
      const g = window.__game
      const d = g.debug()
      const v = d.worldView
      const z = d.zoom
      const cv = document.querySelector('canvas')
      const ctx = cv.getContext('2d')
      const snap = () => ctx.getImageData(0, 0, cv.width, cv.height).data
      // A body's box in canvas px: `setState` puts the container at y + H/2, the sprite hangs
      // above it. Generous by a body width either side; the bodies are 8 widths apart.
      const rects = at.map((p) => ({
        x0: Math.floor((p.x - W - v.x) * z),
        x1: Math.ceil((p.x + W - v.x) * z),
        y0: Math.floor((p.y + H / 2 - 1.5 * H - v.y) * z),
        y1: Math.ceil((p.y + H / 2 + 2 - v.y) * z),
      }))
      const on = snap()
      return new Promise((done) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const on2 = snap()
            g.showSkins(null)
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const off = snap()
                const maxd = (a, b, i) =>
                  Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
                const read = (q) => {
                  let changed = 0
                  let drift = 0
                  let R = 0
                  let GB = 0
                  for (let y = Math.max(0, q.y0); y <= Math.min(cv.height - 1, q.y1); y++) {
                    for (let x = Math.max(0, q.x0); x <= Math.min(cv.width - 1, q.x1); x++) {
                      const i = (y * cv.width + x) * 4
                      if (maxd(on, on2, i) > 30) drift++
                      if (maxd(on, off, i) <= 30) continue
                      changed++
                      R += on[i]
                      GB += on[i + 1] + on[i + 2]
                    }
                  }
                  return { changed, drift, warmth: GB ? R / GB : NaN, area: (q.x1 - q.x0) * (q.y1 - q.y0) }
                }
                done({ subject: read(rects[0]), control: read(rects[1]), rects, zoom: z, tint: t })
              }),
            )
          }),
        )
      })
    },
    [placed.at, C.PLAYER_W, C.PLAYER_H, tint],
  )
  log(`subject ${JSON.stringify(r.subject)}; control ${JSON.stringify(r.control)}; zoom ${r.zoom}`)

  const minBody = C.PLAYER_W * C.PLAYER_H * r.zoom * r.zoom * 0.2
  for (const [name, b] of [['subject', r.subject], ['control', r.control]]) {
    if (b.changed < minBody) throw new Error(`the ${name} body changed ${b.changed} px (< ${minBody.toFixed(0)}) — no body is drawn there`)
    if (b.drift > b.changed * 0.05) throw new Error(`the ${name} rect drifted by ${b.drift} px with nothing changed — frames are not comparable`)
  }
  const sizeRatio = r.subject.changed / r.control.changed
  if (sizeRatio < 0.85 || sizeRatio > 1.15) {
    throw new Error(`the bodies cover ${r.subject.changed} and ${r.control.changed} px — not the same art, so no tint comparison`)
  }
  // A multiply by the tint scales R / (G + B) by this, for any texel whose channels are not clipped.
  const tr = (tint >> 16) & 255
  const tgb = ((tint >> 8) & 255) + (tint & 255)
  const expected = (tr / tgb) / (255 / 510)
  const bar = 1 + (expected - 1) / 2
  const shift = r.subject.warmth / r.control.warmth
  log(`warmth R/(G+B): subject ${r.subject.warmth.toFixed(3)}, control ${r.control.warmth.toFixed(3)} → ${shift.toFixed(2)}x (tint predicts ${expected.toFixed(2)}x, bar ${bar.toFixed(2)}x)`)
  if (!(shift >= bar)) {
    throw new Error(
      `${subject.name} is only ${shift.toFixed(2)}x as warm as ${control.name} in the same frame (needs ${bar.toFixed(2)}x) — ` +
        'the tint is not reaching the Canvas picture',
    )
  }
}
