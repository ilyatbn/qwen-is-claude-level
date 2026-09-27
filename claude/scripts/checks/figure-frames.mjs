/**
 * T23.14: helpers for the checks that photograph the stick figure (`boots-visible`, `wings-visible`,
 * `stick-figure`). The figure is an actor in the world renderer, so these read the **world canvas**
 * (`__world.readFrame`) — the canvas the figure is drawn on — and compare regions given in mask px.
 */

export const decode = (f) => ({ width: f.w, height: f.h, data: Uint8Array.from(Buffer.from(f.rgba, 'base64')), view: f.view })

/** Wait until the sandbox body is still, then freeze the scene; the live figure actor and body as they are. */
export async function freezeStill(page) {
  const dbg = () => page.evaluate(() => window.__game.debug())
  let d = null
  for (let i = 0; i < 60; i++) {
    const a = await dbg()
    await page.waitForTimeout(100)
    const b = await dbg()
    d = b
    if (a.player && b.player && a.player.x === b.player.x && a.player.y === b.player.y && b.figure) break
  }
  if (!d?.player || !d.figure) throw new Error('the sandbox has no still player with a figure')
  await page.evaluate(() => window.__game.freeze(true))
  return (await dbg())
}

export async function frameWith(page, actors) {
  await page.evaluate((a) => window.__world.setActors(a), actors)
  return decode(await page.evaluate(() => window.__world.readFrame()))
}

/** Mean |Δ| per channel between two frames over the buffer px whose mask position lies in rect [x0, y0, x1, y1]. */
export function rectDelta(a, b, [x0, y0, x1, y1]) {
  const k = a.width / a.view.w
  let s = 0
  let n = 0
  for (let y = 0; y < a.height; y++) {
    const my = a.view.y + (y + 0.5) / k
    if (my < y0 || my >= y1) continue
    for (let x = 0; x < a.width; x++) {
      const mx = a.view.x + (x + 0.5) / k
      if (mx < x0 || mx >= x1) continue
      const o = (y * a.width + x) * 4
      for (let c = 0; c < 3; c++) s += Math.abs(a.data[o + c] - b.data[o + c])
      n += 3
    }
  }
  return { mean: n ? s / n : 0, px: n / 3 }
}

/** The actor with its pose changed by `f(J)`. */
export const withPose = (actor, f) => ({ ...actor, opts: { ...actor.opts, J: f({ ...actor.opts.J }) } })
