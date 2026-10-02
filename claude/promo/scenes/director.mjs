/**
 * The camera directors for the gameplay scenes (M99, T99.04). Each runs **in the page**: it is
 * serialised with `toString()` and rebuilt there, so it must use nothing from this module's scope.
 *
 * `busy` is `capture-match.mjs`'s director, steerable: every frame it scores each fighter by how
 * much is happening near them (other fighters close by, effect lights — blasts, fire, muzzle
 * flashes, beams) and eases the camera toward the busiest, holding a fight until a clearly bigger
 * one starts. A cue (node side) can override it through `window.__dir`:
 *   - `focus = { id }` follows that player, `focus = { x, y }` holds a point, `focus = null` frees it;
 *   - `zoomTo = { z, secs }` eases the zoom there over `secs`;
 *   - `ease` is the follow rate per frame (0..1).
 * `__dir.log` records what the director saw every few frames, for choosing the cut.
 */
export const DIRECTOR = {
  busy: function busy(g, opts) {
    const dir = (window.__dir = {
      log: [],
      cam: null,
      target: null,
      heldFor: 0,
      frame: 0,
      fighters: [],
      focus: opts.focus ?? null,
      zoom: opts.zoom ?? 2,
      zoomFrom: opts.zoom ?? 2,
      zoomTo: null,
      zoomAt: 0,
      ease: opts.ease ?? 0.07,
    })
    g.setZoom(dir.zoom)
    const WEIGHT = { explosion: 4, rocket: 3, flame: 3, laser: 1.5, muzzle: 0.6, jet: 0.3, ...(opts.weight ?? {}) }
    const RANGE = opts.range ?? 350
    let last = performance.now()
    const step = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      dir.frame++
      if (dir.frame % 3 === 1) {
        const d = g.debug()
        dir.fighters = d.stand.remotes.filter((r) => r.at).map((r) => ({ id: r.id, x: r.at.x, y: r.at.y, tilt: r.tilt }))
        // The shake, measured: how far the drawn view sits from the rig's centre (the trauma offset).
        if (d.worldView && d.cameraCentre) {
          const wx = d.worldView.x + d.worldView.width / 2
          const wy = d.worldView.y + d.worldView.height / 2
          dir.shake = Math.max(dir.shake ?? 0, Math.hypot(wx - d.cameraCentre.x, wy - d.cameraCentre.y))
        }
      }
      const lights = g.effectLights()
      const score = (x, y) => {
        let s = 0
        for (const f of dir.fighters) {
          const r = Math.hypot(f.x - x, f.y - y)
          if (r < RANGE) s += 1 - r / RANGE
        }
        for (const l of lights) {
          const w = WEIGHT[l.kind] ?? 0
          const r = Math.hypot(l.x - x, l.y - y)
          if (r < RANGE) s += w * (1 - r / RANGE)
        }
        return s
      }
      let want = null
      const f = dir.focus
      if (f && f.id !== undefined) {
        const who = dir.fighters.find((p) => p.id === f.id)
        if (who) want = { x: who.x + (f.dx ?? 0), y: who.y + (f.dy ?? 0), s: score(who.x, who.y), id: who.id }
        else if (dir.target) want = dir.target // gone (teleported, dead): hold where they were
      } else if (f && f.x !== undefined) {
        want = { x: f.x, y: f.y, s: score(f.x, f.y), id: -1 }
      }
      if (!want) {
        let best = null
        for (const p of dir.fighters) {
          const s = score(p.x, p.y)
          if (!best || s > best.s) best = { x: p.x, y: p.y, s, id: p.id }
        }
        const cur = dir.target && dir.fighters.find((p) => p.id === dir.target.id)
        const curS = cur ? score(cur.x, cur.y) : -1
        dir.heldFor++
        if (best && (!cur || best.s > curS * 1.6 + 0.5 || (dir.heldFor > 240 && best.s > curS))) {
          if (!cur || best.id !== dir.target.id) dir.heldFor = 0
          want = best
        } else if (cur) want = { ...cur, s: curS }
      }
      if (want) {
        dir.target = want
        // The fighters sit a little below the middle: the ground in the lower third, the fight's air above.
        const wy = want.y - (dir.focus?.lift ?? opts.lift ?? 60)
        if (!dir.cam) dir.cam = { x: want.x, y: wy }
        const k = 1 - Math.pow(1 - dir.ease, dt * 60)
        dir.cam.x += (want.x - dir.cam.x) * k
        dir.cam.y += (wy - dir.cam.y) * k
        g.watch(dir.cam.x, dir.cam.y)
      }
      // A map resync rebuilds the world view at the game's zoom; the shot's zoom is put back the same frame.
      if (!dir.zoomTo) g.setZoom(dir.zoom)
      if (dir.zoomTo) {
        const u = Math.min(1, (now - dir.zoomAt) / 1000 / dir.zoomTo.secs)
        const e = u * u * (3 - 2 * u)
        dir.zoom = dir.zoomFrom + (dir.zoomTo.z - dir.zoomFrom) * e
        g.setZoom(dir.zoom)
        if (u >= 1) {
          dir.zoomFrom = dir.zoom
          dir.zoomTo = null
        }
      }
      if (dir.frame % 6 === 0) {
        const kinds = {}
        for (const l of lights) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1
        dir.log.push({ t: Date.now() / 1000, s: want ? +want.s.toFixed(2) : 0, id: want?.id ?? null, kinds, shake: +(dir.shake ?? 0).toFixed(1) })
        dir.shake = 0
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  },
}

/** Node side: ease the page's zoom to `z` over `secs`. */
export const zoomTo = (page, z, secs) =>
  page.evaluate(
    ([z, secs]) => {
      const d = window.__dir
      d.zoomFrom = d.zoom
      d.zoomTo = { z, secs }
      d.zoomAt = performance.now()
    },
    [z, secs],
  )

/** Node side: point the director at a player (`{ id }`), a spot (`{ x, y }`), or free it (`null`). */
export const focus = (page, f, ease) =>
  page.evaluate(
    ([f, ease]) => {
      window.__dir.focus = f
      if (ease !== undefined) window.__dir.ease = ease
    },
    [f, ease],
  )
