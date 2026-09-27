/**
 * `look-albedo` — T23.06: the rock's albedo, painted on the GPU, against the mockup's; and live.
 *
 * ## 1. Level A, lighting flat: the look-lab's F1 albedo against the mockup's own
 *
 * `?look=F1&only=albedo` puts F1's masks through the Rust fields (`labFields.ts`) and the GPU
 * albedo pass, with F1's scorch list as blasts, and draws the albedo flat (sRGB bytes straight to the
 * canvas, air black — `WorldRenderer.showAlbedo`). The reference is `world.js::derive` drawn the same
 * way by `reference/controls/albedoonly.mjs` (`controls/F1-albedo.png`, rendered twice
 * byte-identical: the mockup side's floor is 0). Three things are asserted before the picture:
 * - **the fields are the mockup's**: each channel of the lab's fields (FNV-1a-32 over the 720 scene
 *   rows) equals T23.05's mockup dump (`render_fields.fixture.json`) — the padding to 768 rows
 *   changes nothing;
 * - **the GLSL hash is the mockup's, word for word**: 10k words read back from the shader equal
 *   `world.js`'s own (its `vnoise` at integer points is its `hash`);
 * - **the lab frame is deterministic**: a second load reads back byte-identical (the lab's floor).
 * Then every `look-thresholds.json` metric must sit within its threshold, and the exact per-pixel
 * agreement is printed. Control: the same frame against the mockup's albedo in another palette
 * (`F1-albedo-meadow.png`) must fail.
 *
 * ## 2. Live: a blast in the sandbox changes only its dirty rect, and scorches only where it was
 *
 * Sandbox, seed 4242, low tier. Once the round-start fields are in (the worker) and every albedo
 * tile is painted, the albedo around the player is read back; a bazooka is fired into the ground at
 * the player's feet; after the blast the same region is read again. **Every texel that changed lies
 * inside a rect the renderer repainted** (0 outside — presence: some did change), and **scorch**
 * (albedo within `SCORCH_NEAR` of `THEMES.dusk.scorch`) appears inside the blast's scorch circle
 * and nowhere else — both counted against the pre-blast frame as the control. The update's cost
 * (the carve's wasm update, then the upload and repaint finished on the GPU) is printed beside
 * `CHUNK_REBAKE_MS`; on SwiftShader it is reported, not gated (a wall clock on a loaded box).
 *
 * ## 3. A scorch alone (T23.06B F8): its repaint reaches the grass it kills
 *
 * A scorch with no carve — `__world.scorchOnly`, the production `TerrainGpu.addScorch` — centred
 * just under a grassy surface, so its circle takes the surface rock and its box stops a few px
 * above it: the grass blades that grew from that rock (up to 19 px tall) are outside the box and
 * must go. No fields rect covers them (nothing was carved), so only `ALBEDO_REACH` does: the
 * incremental albedo must equal a full repaint (0 texels differ), and the control is presence —
 * fringe texels above the surface really changed.
 *
 * ## 4. A same-map resync keeps the picture (T23.06B F3, R23)
 *
 * `__game.resyncTerrain()` does what a networked resync's second `map_init` does: new fields for the
 * same map. The renderer keeps its GPU side — `ready` is true at once and at every frame until the new
 * fields are installed and repainted (T23.07 reads it to keep Phaser's rock or not: never absent) — and
 * keeps its scorch (R23: scorch history is cosmetic and not on the wire; a client keeps its own). The
 * control is a regenerate — a new map — whose GPU side is new: not ready at first, no scorch.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { actorBoxes, compare, loadPng, withActors } from '../lib/look-compare.mjs'
import { HIGH_QUALITY_KEY } from '../lib/check-tier.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { PNG } = createRequire(join(root, 'client/package.json'))('pngjs')
const ref = (p) => join(root, 'tasks/M23/reference', p)
const FIXTURE = JSON.parse(readFileSync(join(root, 'crates/game-wasm/src/render_fields.fixture.json'), 'utf8'))

/** `world.js::THEMES.dusk.scorch` — a px this close (max channel) to it is scorched. */
const SCORCH = [20, 16, 16]
const SCORCH_NEAR = 10
/** Half the side of the region read around the player, world px. */
const HALF = 260

/** `albedo.ts::probeInput`, the shader's inline inputs. */
const probeInput = (i) => [((i * 7919) % 40009) - 20000, ((i * 104729) % 30011) - 15000, i % 211]

const decode = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'))

async function labFrame(page) {
  const base = new URL(page.url())
  base.search = '?look=F1&only=albedo'
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__look && (window.__look.ready || window.__look.error) && !!window.__world, null, { timeout: 120_000 })
  const look = await page.evaluate(() => window.__look)
  if (look.error) throw new Error(`look-lab F1 albedo: ${look.error}`)
  const f = await page.evaluate(() => window.__world.readFrame())
  return { look, frame: { width: f.w, height: f.h, data: decode(f.rgba) } }
}

function pixelStats(a, b) {
  const n = a.width * a.height
  let exact = 0
  let near2 = 0
  let sum = 0
  let max = 0
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    let d = 0
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]))
    if (d === 0) exact++
    if (d <= 2) near2++
    sum += d
    max = Math.max(max, d)
    hist[d]++
  }
  let acc = 0
  let p99 = 0
  for (let d = 0; d < 256; d++) {
    acc += hist[d]
    if (acc >= n * 0.99) {
      p99 = d
      break
    }
  }
  return { exact: exact / n, near2: near2 / n, mean: sum / n, p99, max }
}

function sideBySide(a, b, path) {
  const out = new PNG({ width: a.width * 2 + 8, height: a.height })
  out.data.fill(255)
  for (let y = 0; y < a.height; y++) {
    for (const [img, x0] of [[a, 0], [b, a.width + 8]]) {
      Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(out.data, (y * out.width + x0) * 4)
    }
  }
  writeFileSync(path, PNG.sync.write(out))
}

export default async function (ctx) {
  try {
    await run(ctx)
  } catch (e) {
    ctx.log(String(e.stack).split('\n').slice(0, 3).join(' | '))
    throw e
  }
}

async function run({ page, shot, log }) {
  const problems = []
  // ------------------------------------------------------------ 1. Level A, flat
  await page.evaluate((k) => localStorage.setItem(k, '1'), HIGH_QUALITY_KEY)
  const { look, frame: lab } = await labFrame(page)
  await shot('look-albedo-F1')
  const info = await page.evaluate(() => window.__world.info())
  if (info.tier !== 'full' || info.buffer[0] !== 1280 || info.buffer[1] !== 720) {
    throw new Error(`want the full tier's 1280x720 buffer (1 texel = 1 px), got ${JSON.stringify(info)}`)
  }
  const want = FIXTURE.fnv32
  for (const k of ['din', 'dout', 'back', 'relief_u8']) {
    const ok = look.fields?.[k] === want[k]
    log(`fields ${k.padEnd(9)} lab ${look.fields?.[k]} mockup ${want[k]} ${ok ? 'ok' : 'DIFFER'}`)
    if (!ok) problems.push(`the lab's ${k} channel is not the mockup's (padding or input)`)
  }

  const words = await page.evaluate(() => window.__world.hashProbe())
  const worldJs = readFileSync(ref('mockup-src/world.js')).toString('base64')
  const { vnoise } = await import(`data:text/javascript;base64,${worldJs}`)
  let hashBad = 0
  let negatives = 0
  for (let i = 0; i < 10_000; i++) {
    const [x, y, s] = probeInput(i)
    if (x < 0 || y < 0) negatives++
    if (vnoise(x, y, s) * 4294967296 !== words[i]) hashBad++
  }
  log(`GLSL hash vs world.js::hash: ${10_000 - hashBad}/10000 words equal (${negatives} with a negative input)`)
  if (words.length !== 10_000 || hashBad !== 0) problems.push(`GLSL hash differs from the mockup's on ${hashBad} of ${words.length} words`)

  const again = (await labFrame(page)).frame
  const floorLab = pixelStats(lab, again)
  log(`lab floor (two loads): ${(floorLab.exact * 100).toFixed(3)} % px exact, max |d| ${floorLab.max}`)
  if (floorLab.max !== 0) problems.push(`the lab's albedo frame is not deterministic (max |d| ${floorLab.max})`)

  const mock = loadPng(ref('controls/F1-albedo.png'))
  mkShots(lab, mock)
  // Level A for the albedo alone, by R19's rule with this picture's own must-fail controls: each
  // metric's threshold is the midpoint of the floor (0: the mockup renders byte-identical twice, and
  // so does the lab) and the smallest control; a metric no control moves off 0 is dropped.
  const regions = withActors(loadPng(ref('controls/regions-F1.png')), actorBoxes('F1'))
  const controls = { meadow: 'controls/F1-albedo-meadow.png', noscorch: 'controls/F1-albedo-noscorch.png' }
  const px = pixelStats(lab, mock)
  log(`lab vs mockup albedo, per px (max channel |d|): exact ${(px.exact * 100).toFixed(2)} %, ≤2 ${(px.near2 * 100).toFixed(2)} %, mean ${px.mean.toFixed(3)}, p99 ${px.p99}, max ${px.max}`)
  const m = compare(lab, mock, { regions })
  const rows = Object.fromEntries(Object.entries(controls).map(([k, f]) => [k, compare(loadPng(ref(f)), mock, { regions })]))
  const failed = []
  let kept = 0
  for (const k of Object.keys(m).filter((k) => typeof m[k] === 'number')) {
    const [cName, c] = Object.entries(rows).map(([n, r]) => [n, r[k]]).sort((a, b) => a[1] - b[1])[0]
    if (!(c > 0)) {
      log(`  ${k.padEnd(15)} ${m[k].toFixed(5).padStart(10)}  dropped (no control moves it)`)
      continue
    }
    kept++
    const th = c / 2
    const ok = m[k] <= th
    if (!ok) failed.push(k)
    log(`  ${k.padEnd(15)} ${m[k].toFixed(5).padStart(10)}  max ${th.toPrecision(4).padEnd(10)} (smallest control ${cName} ${c.toPrecision(4)}) ${ok ? 'ok' : 'FAIL'}`)
  }
  if (kept < 5) problems.push(`only ${kept} metrics separate the floor from the controls`)
  if (failed.length) problems.push(`the lab's albedo is outside its Level A thresholds on ${failed.join(', ')}`)
  // The lab frame itself must fail against each control, or the controls say nothing about it.
  for (const [n, f] of Object.entries(controls)) {
    const d = pixelStats(lab, loadPng(ref(f)))
    log(`control: lab vs ${n}: per px mean ${d.mean.toFixed(3)}, exact ${(d.exact * 100).toFixed(2)} %`)
    if (!(d.mean > 2 * px.mean)) problems.push(`control: the lab frame is as close to ${n} as to the reference`)
  }
  function mkShots(a, b) {
    sideBySide(a, b, join(root, 'shots', 'look-albedo-F1-vs-reference.png'))
    const d = new PNG({ width: a.width, height: a.height })
    for (let i = 0; i < a.width * a.height; i++) {
      let v = 0
      for (let c = 0; c < 3; c++) v = Math.max(v, Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]))
      d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = Math.min(255, v * 16)
      d.data[i * 4 + 3] = 255
    }
    writeFileSync(join(root, 'shots', 'look-albedo-F1-diff-x16.png'), PNG.sync.write(d))
    log('side by side (lab | mockup): shots/look-albedo-F1-vs-reference.png; |d| ×16: shots/look-albedo-F1-diff-x16.png')
  }

  // ------------------------------------------------------------ 2. live, sandbox
  await page.evaluate((k) => localStorage.setItem(k, '0'), HIGH_QUALITY_KEY)
  const base = new URL(page.url())
  base.search = '?sandbox=1&seed=4242'
  await page.goto(base.href, { waitUntil: 'load' })
  await page.waitForFunction(() => {
    const t = window.__world?.terrain?.()
    return !!window.__game && !!t && t.fields && t.ready && t.pending === 0
  }, null, { timeout: 180_000 })
  const t0 = await page.evaluate(() => window.__world.terrain())
  const K = await page.evaluate(() => window.__game.constants())
  log(`sandbox ${t0.w}x${t0.h}: worker ${t0.feed.workerMs.toFixed(0)} ms (landform + full fields), job ${t0.feed.jobMs.toFixed(0)} ms to install, install ${t0.feed.installMs.toFixed(1)} ms on the frame; ${t0.tiles} albedo tiles`)

  const me = await page.evaluate(() => {
    const d = window.__game.debug()
    const raw = d.worldView
    const v = { x: raw.x, y: raw.y, w: raw.width ?? raw.w, h: raw.height ?? raw.h }
    const r = document.querySelector('canvas').getBoundingClientRect()
    return { wx: Math.round(d.player.x), wy: Math.round(d.player.y), sx: r.left + ((d.player.x - v.x) / v.w) * r.width, sy: r.top + ((d.player.y - v.y) / v.h) * r.height }
  })
  const reg = { x: Math.max(0, me.wx - HALF), y: Math.max(0, me.wy - HALF), w: 2 * HALF, h: 2 * HALF }
  reg.w = Math.min(reg.w, t0.w - reg.x)
  reg.h = Math.min(reg.h, t0.h - reg.y)
  const read = async () => decode(await page.evaluate((r) => window.__world.readAlbedo(r.x, r.y, r.w, r.h), reg))
  await page.evaluate(() => window.__world.albedoPaints(true))
  const pre = await read()
  await page.mouse.move(me.sx, me.sy + 200)
  await page.waitForTimeout(200)
  const ev = await page.evaluate(() => window.__game.fire())
  if (ev.rejected || !ev.projectile) throw new Error(`the bazooka did not fire: ${JSON.stringify(ev).slice(0, 160)}`)
  await page.waitForFunction((n) => window.__world.terrain().scorches > n, t0.scorches, { timeout: 30_000 })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const paints = await page.evaluate(() => window.__world.albedoPaints(false))
  const t1 = await page.evaluate(() => window.__world.terrain())
  const post = await read()
  const [bx, by, br] = t1.lastScorch
  const inside = (x, y) => paints.some((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)
  let changedIn = 0
  let changedOut = 0
  let scorchIn = 0
  let scorchOut = 0
  let scorchPreIn = 0
  let scorchPreOut = 0
  const near = (a, o) => Math.max(Math.abs(a[o] - SCORCH[0]), Math.abs(a[o + 1] - SCORCH[1]), Math.abs(a[o + 2] - SCORCH[2])) <= SCORCH_NEAR && a[o + 3] > 0
  for (let y = 0; y < reg.h; y++) {
    for (let x = 0; x < reg.w; x++) {
      const o = (y * reg.w + x) * 4
      const wx = reg.x + x
      const wy = reg.y + y
      const diff = pre[o] !== post[o] || pre[o + 1] !== post[o + 1] || pre[o + 2] !== post[o + 2] || pre[o + 3] !== post[o + 3]
      if (diff) inside(wx, wy) ? changedIn++ : changedOut++
      const inCircle = Math.hypot(wx - bx, wy - by) < br
      if (near(post, o)) inCircle ? scorchIn++ : scorchOut++
      if (near(pre, o)) inCircle ? scorchPreIn++ : scorchPreOut++
    }
  }
  log(`blast at (${bx.toFixed(0)}, ${by.toFixed(0)}) scorch r ${br.toFixed(0)}; ${paints.length} rect(s) repainted: ${paints.map((p) => `${p.w}x${p.h}@${p.x},${p.y}`).join(' ')}`)
  log(`texels changed: ${changedIn} inside the repainted rects, ${changedOut} outside (of ${reg.w * reg.h} read)`)
  log(`scorched px (within ${SCORCH_NEAR} of ${SCORCH}): in the circle ${scorchPreIn} → ${scorchIn}; elsewhere ${scorchPreOut} → ${scorchOut}`)
  log(`update cost: carve's fields (diff + wasm dirty) ${Number(t1.feed.lastCarveMs).toFixed(2)} ms, upload + repaint to GPU completion ${t1.lastUpdateMs.toFixed(2)} ms (CHUNK_REBAKE_MS ${K.CHUNK_REBAKE_MS}; reported, not gated)`)
  // Incremental == full: fields re-uploaded whole and the albedo repainted from scratch must read back as the blast's
  // dirty updates left it (a rect too small leaves stale texels — soil, grass, scorch — outside it).
  const tiles = t1.tiles
  const repaintMs = await page.evaluate(() => {
    const t = performance.now()
    window.__world.repaintAlbedo()
    window.__world.readAlbedo(0, 0, 1, 1) // finish on the GPU before the clock stops
    return performance.now() - t
  })
  const perTile = repaintMs / ((await page.evaluate(() => window.__world.terrain().tiles)) - tiles)
  log(`full albedo repaint (fields re-uploaded, every tile, finished on the GPU): ${repaintMs.toFixed(0)} ms, ${perTile.toFixed(1)} ms per 256×128 tile — the round-start pass does 1 unit (a tile or a field strip) per frame on the low tier (GAME_ALBEDO_TILES)`)
  const full = await read()
  let stale = 0
  for (let i = 0; i < full.length; i += 4) if (full[i] !== post[i] || full[i + 1] !== post[i + 1] || full[i + 2] !== post[i + 2] || full[i + 3] !== post[i + 3]) stale++
  log(`incremental vs a full repaint of the same fields: ${stale} texels differ`)
  if (stale !== 0) problems.push(`the dirty updates left ${stale} albedo texels stale (≠ a full repaint)`)
  if (changedOut !== 0) problems.push(`${changedOut} albedo texels changed outside the repainted rects`)
  if (!(changedIn > 0)) problems.push('control: the blast changed no albedo texel at all')
  if (!(scorchIn > 200 && scorchIn > 4 * scorchPreIn)) problems.push(`no scorch at the blast: ${scorchPreIn} → ${scorchIn} px in its circle`)
  if (scorchOut !== scorchPreOut) problems.push(`scorch outside the blast's circle: ${scorchPreOut} → ${scorchOut} px`)

  // ------------------------------------------------------------ 3. a scorch alone (F8)
  // A column near the player with a tall blade: fringe (alpha 200) for ≥ 8 px straight above rock (255).
  const regA = await read()
  let col = null
  for (let x = 0; x < reg.w && !col; x += 3) {
    const wx = reg.x + x
    if (Math.abs(wx - bx) < br + 60) continue // clear of the bazooka's crater and its scorch
    for (let y = 20; y < reg.h - 1 && !col; y++) {
      const a = (yy) => regA[(yy * reg.w + x) * 4 + 3]
      if (a(y) === 255 && a(y - 1) === 200) {
        let n = 0
        while (n < 19 && a(y - 1 - n) === 200) n++
        if (n >= 8) col = { wx, wy: reg.y + y, blade: n }
      }
    }
  }
  if (!col) {
    problems.push('F8: no grassy surface with a tall blade near the player to scorch')
  } else {
    const R = 30
    const [cx, cy] = [col.wx, col.wy + R - 3] // the circle's top 3 px into the surface rock
    const reg3 = { x: Math.max(0, col.wx - 60), y: Math.max(0, col.wy - 60), w: 120, h: 120 }
    const read3 = async () => decode(await page.evaluate((r) => window.__world.readAlbedo(r.x, r.y, r.w, r.h), reg3))
    const pre3 = await read3()
    const box = await page.evaluate(([x, y, r]) => window.__world.scorchOnly(x, y, r), [cx, cy, R])
    const post3 = await read3()
    await page.evaluate(() => window.__world.repaintAlbedo())
    const full3 = await read3()
    let stale3 = 0
    let killed = 0
    for (let i = 0; i < full3.length; i += 4) {
      if (full3[i] !== post3[i] || full3[i + 1] !== post3[i + 1] || full3[i + 2] !== post3[i + 2] || full3[i + 3] !== post3[i + 3]) stale3++
      const wy = reg3.y + Math.floor(i / 4 / reg3.w)
      if (wy < col.wy && pre3[i + 3] === 200 && full3[i + 3] !== 200) killed++
    }
    log(`scorch alone at (${cx}, ${cy}) r ${R} under the surface at y ${col.wy} (blade ${col.blade} px): repainted ${box.w}x${box.h}@${box.x},${box.y}; grass texels killed above the surface ${killed}; incremental vs full ${stale3} differ`)
    if (!(killed > 0)) problems.push('F8 control: the scorch killed no grass above the surface — the case is not exercised')
    if (stale3 !== 0) problems.push(`F8: a scorch alone left ${stale3} albedo texels stale (the repaint does not reach the grass it kills)`)
  }

  // ------------------------------------------------------------ 4. a same-map resync (F3, R23)
  const scorchedIn = (a) => {
    let n = 0
    for (let y = 0; y < reg.h; y++) {
      for (let x = 0; x < reg.w; x++) if (Math.hypot(reg.x + x - bx, reg.y + y - by) < br && near(a, (y * reg.w + x) * 4)) n++
    }
    return n
  }
  const sc0 = scorchedIn(await read())
  const k0 = (await page.evaluate(() => window.__world.terrain())).kept
  const resync = await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.__game.resyncTerrain()
        const first = window.__world.terrain()
        let notReady = first.ready ? 0 : 1
        let frames = 0
        let sawWork = false
        const tick = () => {
          const t = window.__world.terrain()
          frames++
          if (!t.ready) notReady++
          if (t.pending > 0) sawWork = true
          if ((t.fields && sawWork && t.pending === 0) || frames > 3000) return resolve({ first, notReady, frames, sawWork, kept: t.kept })
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  const sc1 = scorchedIn(await read())
  log(`resync (same map): kept ${k0} → ${resync.kept}; ready at once ${resync.first.ready}, frames not ready ${resync.notReady} of ${resync.frames} to the repaint's end (work seen ${resync.sawWork}); scorched px in the blast circle ${sc0} → ${sc1}`)
  if (resync.kept !== k0 + 1 || !resync.first.gpu) problems.push(`F3: a same-map resync did not keep the GPU side (kept ${k0} → ${resync.kept})`)
  if (resync.notReady !== 0) problems.push(`F3: the terrain was not ready on ${resync.notReady} frames of a same-map resync — it would flash Phaser's rock`)
  if (!resync.sawWork) problems.push('F3 control: the resync repainted nothing — the new fields never installed')
  if (!(sc1 > 200 && sc1 >= sc0 * 0.9)) problems.push(`R23: the resync lost this client's scorch (${sc0} → ${sc1} px)`)
  // Control: a regenerate is a new map — a new GPU side, not ready at first, no scorch.
  const regen = await page.evaluate(() => {
    window.__game.regenerate('4242')
    return window.__world.terrain()
  })
  log(`control: regenerate (a new map): ready at once ${regen.ready}, kept ${regen.kept}, scorches ${regen.scorches}`)
  if (regen.ready || regen.kept !== resync.kept || regen.scorches !== 0) problems.push(`F3 control: a regenerate kept the old GPU side (ready ${regen.ready}, kept ${regen.kept}, scorches ${regen.scorches})`)

  // For a person: the albedo around the blast, before | after (air black). In the game it is not
  // drawn yet — Phaser's terrain covers it until T23.07 lights it.
  const flat = (a) => {
    const o = new Uint8Array(a)
    for (let i = 0; i < o.length; i += 4) if (o[i + 3] === 0) o[i] = o[i + 1] = o[i + 2] = 0
    for (let i = 3; i < o.length; i += 4) o[i] = 255
    return { width: reg.w, height: reg.h, data: o }
  }
  sideBySide(flat(pre), flat(post), join(root, 'shots', 'look-albedo-sandbox-blast.png'))
  log('before | after the blast (albedo, flat): shots/look-albedo-sandbox-blast.png')

  if (problems.length) throw new Error(`look-albedo:\n  - ${problems.join('\n  - ')}`)
}
