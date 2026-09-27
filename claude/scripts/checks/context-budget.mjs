#!/usr/bin/env node
/**
 * `context-budget` — T23.04C (R22): one page, many scenes, a bounded number of WebGL contexts.
 *
 *   node scripts/e2e.mjs --only context-budget
 *
 * The review of T23.04 cycled title ↔ match ten times on one page: every scene start built a new
 * three.js `WebGLRenderer` and `destroy()` never released its context, so live contexts went
 * 5 → 16 and GPU-process memory 343 → 933 MB, and at 17 Chrome dropped the oldest — in round 7,
 * **Phaser's own** ("WebGL Context lost. Renderer disabled"): a white page. R22: one renderer for
 * the page's lifetime, scene-owned resources created and disposed per scene, probe contexts released.
 *
 * One page, as a player: title → Start → Quick match → the round plays out (a short round, one bot)
 * → the results screen → Exit to title, `CYCLES` times. At every title and every match:
 *
 * 1. **Live WebGL contexts ≤ `MAX_LIVE`.** Counted at the source: `getContext` is wrapped before
 *    any page script runs, and a context is live until it is lost (`isContextLost()` — a released
 *    probe reads true at once) or its canvas is collected. The budget: Phaser's feature probe
 *    (Phaser 3.90 `device/Features.js` asks a throwaway canvas for `webgl` and keeps nothing to
 *    release it by), Phaser's renderer, and the page's one three.js renderer.
 * 2. **Phaser's context is never lost** — the white page itself.
 * 3. **three holds the same at every title, and the same at every match** (`__world.info().memory`:
 *    **T23.06B (F5): a match is sampled twice** — at `ready`, and again once the terrain's GPU side
 *    is installed and whole (`__world.terrain()`: fields in, `ready`, nothing pending), so its four
 *    world-sized textures (fields, `dIn²`, albedo, scorch — the ~92 MB of a Large map) are counted
 *    after the work that fills them, not before;
 *    geometries, textures, programs). A scene that leaks one render target shows here in one cycle.
 * 4. **GPU-process memory is flat** — the measured proxy (resident set of the browser's GPU
 *    process, `SystemInfo.getProcessInfo` → `/proc/<pid>/status`). Before R22 it grew 36–90 MB a
 *    cycle (one sky bake is 34–43 MB at the low tier). Gated as: the median of the last five titles
 *    minus the median of titles 2–6 is under `RSS_GROWTH_MB` — basis below.
 *
 * Presence controls: the counter must see Phaser's context and at least one three.js context (a
 * wrapper that saw nothing would pass the budget), and the match must really have drawn the world
 * (a frame read back from the world canvas in a match).
 */
import { readFileSync } from 'node:fs'
import { startStack, tally, freePort } from './harness.mjs'
import { key as clientKey } from '../lib/client-keys.mjs'

/** Title → match → results → exit round trips on one page. The review lost Phaser's context in round 7. */
const CYCLES = 20
/** Phaser's feature probe, Phaser's renderer, the page's one three.js renderer (R22). */
const MAX_LIVE = 3
/**
 * GPU-process growth allowed between the early and the late titles, MB. Basis: a leak of the
 * smallest thing R22 is about — one low-tier sky bake (34 MB) per cycle — grows it ≥ 34 × 14 MB over
 * the fourteen cycles between the two windows, and the review measured 36–90 MB a cycle. After R22 the
 * spread across titles is measured (printed as `rss spread`); this sits above it and far below
 * one bake per cycle.
 */
const RSS_GROWTH_MB = 120
/** The match: one bot fills the lobby at once, a short warmup and a short round, straight to results. */
const ROUND_S = 3
const J = JSON.stringify

const t = tally('context-budget')
const { ok } = t
const stack = await startStack({
  port: await freePort(),
  label: 'context-budget',
  env: { BOT_COUNT: '1', LOBBY_BOT_TIMEOUT: '0.5', DEV_WARMUP_SECONDS: '0.5', ROUND_SECONDS: String(ROUND_S), WEATHER: 'off' },
})

/** Installed before any page script: every WebGL context the page makes, and whether it still lives. */
function counter() {
  const recs = []
  const orig = HTMLCanvasElement.prototype.getContext
  const seen = new WeakSet()
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (ctx && /webgl/.test(String(type)) && !seen.has(this)) {
      seen.add(this)
      const rec = { id: recs.length, type: String(type), lost: false, canvas: new WeakRef(this), gl: new WeakRef(ctx), at: (new Error().stack ?? '').split('\n').slice(2, 4).map((s) => s.trim()).join(' < ') }
      this.addEventListener('webglcontextlost', () => {
        rec.lost = true
      })
      recs.push(rec)
    }
    return ctx
  }
  window.__contexts = () => {
    const phaser = document.querySelector('#game canvas:not([data-world])')
    return recs.map((r) => {
      const c = r.canvas.deref()
      const gl = r.gl.deref()
      const lost = r.lost || (gl ? gl.isContextLost() : false)
      return { id: r.id, type: r.type, lost, collected: !c, live: !!c && !lost, phaser: !!c && c === phaser, world: c?.dataset?.world === 'three', attached: !!c && c.isConnected, at: r.at }
    })
  }
}

/** The GPU process's resident set, MB — `null` if this browser will not say which process it is. */
async function gpuRssMb(cdp) {
  try {
    const info = await cdp.send('SystemInfo.getProcessInfo')
    const gpu = info.processInfo.find((p) => p.type === 'GPU')
    if (!gpu) return null
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${gpu.id}/status`, 'utf8'))
    return m ? Number(m[1]) / 1024 : null
  } catch {
    return null
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}

try {
  const ctx = await stack.browser.newContext({ viewport: { width: 1280, height: 720 } })
  await ctx.addInitScript(counter)
  const page = await ctx.newPage()
  const errors = []
  const consoleLost = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (/context lost|Too many active WebGL contexts/i.test(m.text())) consoleLost.push(m.text())
  })
  // Browser-level: `SystemInfo` answers only there (a page session says "not found", measured).
  const cdp = await ctx.browser().newBrowserCDPSession()
  await page.goto(`${stack.viteUrl}/?e2e=1`)
  await page.waitForSelector('#start-game', { timeout: 60_000 })
  await page.evaluate((kv) => localStorage.setItem(kv[0], kv[1]), [clientKey('NAME_KEY'), 'ana'])

  /** The world handle of `scene`, drawn at least once — never the last scene's handle. */
  const worldOf = async (scene) => {
    await page.waitForFunction((s) => window.__world?.scene === s && window.__world.backend === 'three', scene, { timeout: 60_000 })
    const f = await page.evaluate(() => window.__world.readFrame().then((r) => (r ? { w: r.w, h: r.h } : null)))
    return { frame: f, info: await page.evaluate(() => window.__world.info()) }
  }
  const sample = async (where, scene) => {
    const w = await worldOf(scene)
    const ctxs = await page.evaluate(() => window.__contexts())
    const glows = await page.evaluate(() => window.__world.actors?.()?.glows ?? null)
    return { where, frame: w.frame, memory: w.info?.memory ?? null, names: w.info?.programNames ?? [], glows, bakeMB: (w.info?.skyBakeBytes ?? 0) / 1e6, ctxs, live: ctxs.filter((c) => c.live).length, rss: await gpuRssMb(cdp) }
  }
  const line = (s) =>
    `${s.where}: live ${s.live} of ${s.ctxs.length} made (${s.ctxs.filter((c) => c.live).map((c) => (c.phaser ? 'phaser' : c.world ? 'three' : `#${c.id}`)).join(',')}); three ${J(s.memory)}; named ${J(s.names.filter((n) => n !== '?'))}; glows ${s.glows}; bake ${s.bakeMB.toFixed(1)} MB; gpu rss ${s.rss === null ? '?' : s.rss.toFixed(0)} MB`

  const titles = []
  const matches = []
  const installed = []
  for (let i = 0; i < CYCLES; i++) {
    const ts = await sample(`cycle ${i} title`, 'Title')
    titles.push(ts)
    console.log(`  ${line(ts)}`)
    await page.click('#start-game', { timeout: 30_000 })
    await page.waitForFunction('!!window.__menu', null, { timeout: 30_000 })
    await page.click('#quick', { timeout: 30_000 })
    // A torn-down scene leaves `__game` pointing at a dead camera: absent, not thrown.
    await page.waitForFunction(() => {
      try {
        return window.__game?.debug().ready === true
      } catch {
        return false
      }
    }, null, { timeout: 60_000 })
    const ms = await sample(`cycle ${i} match`, 'Game')
    matches.push(ms)
    console.log(`  ${line(ms)}`)
    // F5: and after the terrain is in and painted.
    await page.waitForFunction(() => {
      const t = window.__world?.terrain?.()
      return !!t && t.fields && t.ready && t.pending === 0
    }, null, { timeout: 60_000 })
    const mt = await sample(`cycle ${i} match+terrain`, 'Game')
    mt.terrainMB = (await page.evaluate(() => window.__world.terrain().bytes)) / 2 ** 20
    installed.push(mt)
    console.log(`  ${line(mt)}; terrain GPU side ${mt.terrainMB.toFixed(1)} MB`)
    await page.waitForSelector('.results-screen', { timeout: (ROUND_S + 60) * 1000 })
    await page.click('.results-exit', { timeout: 30_000 })
    await page.waitForSelector('#start-game', { timeout: 30_000 })
    // Phaser's context, the moment it matters: after the scene that would have made the 17th.
    const phaserLost = await page.evaluate(() => window.__contexts().some((c) => c.phaser && c.lost))
    if (phaserLost) {
      t.fail(`cycle ${i}: Phaser's WebGL context was lost — the page is white`)
      break
    }
  }

  const all = [...titles, ...matches, ...installed]
  // F5's presence control: the installed samples really hold a terrain GPU side.
  if (installed.length !== matches.length || installed.some((s) => !(s.terrainMB > 0))) t.fail(`F5: ${installed.length} of ${matches.length} matches sampled with a terrain GPU side`)
  else ok(`every match sampled again with its terrain installed (${installed[0].terrainMB.toFixed(1)} MB GPU side)`)
  // Presence: the counter saw Phaser's context and a three.js one, and the match drew the world.
  const sawPhaser = all.every((s) => s.ctxs.some((c) => c.phaser && c.live))
  const sawThree = all.every((s) => s.ctxs.some((c) => c.world && c.live))
  if (!sawPhaser || !sawThree) t.fail(`control: the counter did not see Phaser's (${sawPhaser}) and three's (${sawThree}) live contexts at every sample`)
  else ok(`control: the counter sees Phaser's context and a three.js context live at all ${all.length} samples`)
  const undrawn = matches.filter((s) => !s.frame)
  if (undrawn.length) t.fail(`control: ${undrawn.length} matches drew no world frame (${undrawn.map((s) => s.where).join(', ')})`)
  else ok(`control: every match drew the world (a ${matches[0]?.frame?.w}x${matches[0]?.frame?.h} frame read back)`)

  // 1. The budget.
  const worst = all.reduce((m, s) => (s.live > m.live ? s : m), all[0])
  const made = all[all.length - 1]?.ctxs.length ?? 0
  if (worst.live > MAX_LIVE) {
    t.fail(`live WebGL contexts reached ${worst.live} (max ${MAX_LIVE}) at ${worst.where}; ${made} made over ${titles.length} cycles: ${J(worst.ctxs.filter((c) => c.live).map((c) => c.at))}`)
  } else {
    ok(`live WebGL contexts at most ${worst.live} (max ${MAX_LIVE}) over ${titles.length} cycles, ${made} made in all`)
  }
  // R22 itself: one three.js context for the page's lifetime, however many scenes drew the world.
  // Deterministic where (1) is not: a released-by-GC context is not live, and the old code's
  // per-scene renderers were often collected before the next sample (measured: 4, not 16, live).
  const last = all[all.length - 1]?.ctxs ?? []
  const threeSeen = new Set(all.flatMap((s) => s.ctxs.filter((c) => c.world).map((c) => c.id))).size
  if (threeSeen !== 1) t.fail(`${threeSeen} three.js contexts drew the world over ${titles.length} cycles — R22 wants one for the page`)
  else ok(`one three.js context for the page: the same context drew all ${all.length} scenes`)
  // The probe in `webgl2.ts` releases what it made.
  const probe = last.filter((c) => /probeWebgl2/.test(c.at))
  if (probe.length !== 1) t.fail(`the WebGL2 probe made ${probe.length} contexts, want 1 (the counter's control)`)
  else if (!probe[0].lost && !probe[0].collected) t.fail(`the WebGL2 probe's context is still live: ${J(probe[0])}`)
  else ok(`the WebGL2 probe's context is ${probe[0].lost ? 'released' : 'collected'}`)
  // 2. Phaser's context.
  const phaserEverLost = all.some((s) => s.ctxs.some((c) => c.phaser && c.lost))
  if (phaserEverLost || consoleLost.length) t.fail(`Phaser's context lost or contexts dropped: ${J(consoleLost.slice(0, 3))}`)
  else ok(`Phaser's context never lost; no "too many contexts" warning`)
  // 3. three's memory, the same at every title and at every match.
  for (const [name, list] of [['title', titles], ['match', matches], ['match with the terrain installed', installed]]) {
    const kinds = new Set(list.map((s) => J(s.memory)))
    if (list.some((s) => !s.memory)) t.fail(`${name}: __world.info().memory missing — the instrument reads nothing`)
    else if (kinds.size !== 1) {
      // T23.14C: name what differs — the programs one sample has and another lacks (by `material.name`).
      const count = (s) => s.names.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map())
      const a = count(list[0])
      const odd = list.find((s) => J(s.memory) !== J(list[0].memory))
      const b = count(odd)
      const diff = [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n)).map((n) => `${n} ${a.get(n) ?? 0}→${b.get(n) ?? 0}`)
      t.fail(`three's memory differs between ${name}s: ${[...kinds].join(' / ')}; programs ${list[0].where} → ${odd.where}: ${diff.join(', ') || 'same names'}`)
    }
    else ok(`three holds ${[...kinds][0]} at every ${name} (${list.length})`)
  }
  // 4. GPU-process memory.
  const rss = titles.map((s) => s.rss)
  if (rss.some((v) => v === null)) {
    t.fail('the GPU process resident set could not be read — the memory half measures nothing')
  } else if (titles.length < 12) {
    t.fail(`only ${titles.length} cycles ran — too few to judge growth`)
  } else {
    const early = median(rss.slice(1, 6))
    const late = median(rss.slice(-5))
    const spread = Math.max(...rss.slice(1)) - Math.min(...rss.slice(1))
    console.log(`  gpu rss at the titles, MB: ${rss.map((v) => v.toFixed(0)).join(' ')}; rss spread ${spread.toFixed(0)}`)
    if (late - early > RSS_GROWTH_MB) t.fail(`GPU-process memory grew ${(late - early).toFixed(0)} MB between titles 2–6 and the last five (max ${RSS_GROWTH_MB})`)
    else ok(`GPU-process memory flat: titles 2–6 median ${early.toFixed(0)} MB, last five ${late.toFixed(0)} MB (growth ${(late - early).toFixed(0)}, max ${RSS_GROWTH_MB})`)
  }
  if (errors.length) t.fail(`page errors: ${errors.slice(0, 3).join(' | ')}`)
  else ok('no page errors')
} catch (e) {
  t.fail(`threw: ${e.stack ?? e}`)
}
await t.finish(() => stack.close())
