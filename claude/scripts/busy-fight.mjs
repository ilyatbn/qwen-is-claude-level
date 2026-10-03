#!/usr/bin/env node
/**
 * T23.23 step 3: **the busy-fight frame rate**, a measurement (not a check — D-76: the low tier's fps is reported, not
 * gated). T23.18's script was never committed, so its numbers could not be re-taken on the same basis; this is it,
 * written down: 1 human + 5 bots on `FIXED_SEED` 320 (`DEV_LOADOUT`, `WEATHER=off`), the human firing a bazooka every
 * 250 ms for 8 s at zoom 1; mean fps over the 8 s and frame p50/p99 from rAF. `RUNS` per tier (default 3).
 *
 *   node scripts/busy-fight.mjs                       # SwiftShader (the checks' browser), low then full
 *   TIERS=low RUNS=3 node scripts/busy-fight.mjs
 *   GPU=1 node scripts/busy-fight.mjs                 # headed google-chrome on the real GPU (GALLIUM_DRIVER=d3d12)
 *   HIDE=fg node scripts/busy-fight.mjs               # with world layers hidden (`__world.hideLayers`, '+'-joined)
 *   FRENZY=1 …                                        # bots hunt (DEV_BOT_FRENZY)
 */
import * as H from './checks/harness.mjs'
const { startStack, enterBattle, selectWeapon, freePort, sleep, classicUnlessNamed } = H
import { HIGH_QUALITY_KEY } from './lib/check-tier.mjs'
const tiers = (process.env.TIERS ?? 'low,full').split(',')
const RUNS = Number(process.env.RUNS ?? 3)
for (const tier of tiers) {
  for (let r = 0; r < RUNS; r++) {
    const stack = await startStack({ port: await freePort(), label: 'busy', env: { FIXED_SEED: '320', BOT_COUNT: '5', ...(process.env.FRENZY ? { DEV_BOT_FRENZY: '1' } : {}), DEV_LOADOUT: '1', LOBBY_BOT_TIMEOUT: '1', ROUND_SECONDS: '300', DEV_WARMUP_SECONDS: '1', WEATHER: 'off' } })
    const gpu = process.env.GPU ? await H.chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false, args: ['--ignore-gpu-blocklist', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], env: { ...process.env, GALLIUM_DRIVER: 'd3d12' } }) : null
    const ctx = await (gpu ?? stack.browser).newContext({ viewport: { width: 1280, height: 720 } })
    await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [HIGH_QUALITY_KEY, tier === 'full' ? '1' : '0'])
    const page = await ctx.newPage()
    await page.goto(`${stack.viteUrl}/?e2e=1&game=1&name=ana${classicUnlessNamed('')}`)
    await page.waitForFunction('window.__game && window.__game.debug().me >= 0', null, { timeout: 120_000 })
    await enterBattle(page, { label: 'busy', waitPlaying: true })
    await selectWeapon(page, 'bazooka')
    if (process.env.HIDE) await page.evaluate((h) => window.__world.hideLayers(h.split('+')), process.env.HIDE)
    const info = await page.evaluate(() => window.__world?.info())
    const t = await page.evaluate(async () => {
      const ts = []
      const t0 = performance.now()
      let shots = 0
      const iv = setInterval(() => { try { window.__game.fire(); shots++ } catch {} }, 250)
      await new Promise((res) => { const f = (now) => { ts.push(now); if (now - t0 < 8000) requestAnimationFrame(f); else res() }; requestAnimationFrame(f) })
      clearInterval(iv)
      const d = ts.slice(1).map((v, i) => v - ts[i]).sort((a, b) => a - b)
      return { fps: (ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000), p50: d[Math.floor(d.length * 0.5)], p99: d[Math.floor(d.length * 0.99)], shots }
    })
    console.log(`hide ${process.env.HIDE ?? '-'} tier ${tier} (renderer tier ${info?.tier}, ${JSON.stringify(info?.gpu)?.slice(0, 40)}) run ${r + 1}: ${t.fps.toFixed(1)} fps, p50 ${t.p50.toFixed(1)} ms, p99 ${t.p99.toFixed(1)} ms, ${t.shots} fire calls`)
    if (gpu) await gpu.close()
    await stack.close()
    await sleep(500)
  }
}
process.exit(0)
