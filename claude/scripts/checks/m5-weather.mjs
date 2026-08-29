#!/usr/bin/env node
/**
 * The M5 checkpoint: force each effect and watch it run start to finish.
 *
 * Screenshots all four at their ACTIVE phase, at night, and asserts each one
 * actually did its job — a puddle count, a carve, a darkness change — rather
 * than just that a button existed. Written as a check rather than a unit test
 * because the thing being verified is what a player sees.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { matchVitePort } from '../vite-url.mjs'
import { killGroup } from '../proc-group.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const shots = join(root, 'shots')
mkdirSync(shots, { recursive: true })
process.env.LD_LIBRARY_PATH = `${process.env.HOME}/.cache/pwlibs/root/usr/lib/x86_64-linux-gnu`

const vite = await new Promise((res, rej) => {
  const p = spawn('npx', ['vite', '--strictPort=false'], {
    cwd: join(root, 'client'),
    detached: true,
  })
  // Shared parse (scripts/vite-url.mjs): vite puts an ANSI escape between
  // `localhost:` and the port, so a bare regex here matches nothing whenever the
  // inherited environment turns colour on. Fifth copy of this bug.
  const on = (b) => {
    const port = matchVitePort(b)
    if (port) res({ p, url: `http://localhost:${port}` })
  }
  p.stdout.on('data', on)
  p.stderr.on('data', on)
  setTimeout(() => rej(new Error('vite did not start')), 90_000)
})

// playwright-core lives in client/node_modules, not next to this script.
const require = createRequire(join(root, 'client', 'package.json'))
const { chromium } = require('playwright-core')
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  env: { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH },
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

let failures = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

try {
  await page.goto(`${vite.url}/?sandbox=1&seed=4242&e2e=1`)
  await page.waitForFunction('window.__game && window.__game.debug().mapW > 0', null, {
    timeout: 90_000,
  })
  // Night, so the light each effect emits is visible.
  await page.evaluate('window.__game.setTime(90)')
  await page.waitForTimeout(400)

  const KINDS = [
    ['toxic', 0],
    ['meteor', 1],
    ['lava', 2],
    ['fog', 3],
  ]

  for (const [name, kind] of KINDS) {
    const before = await page.evaluate('window.__game.weatherProbe()')
    const priorIds = new Set(before.active.map((a) => a.id))
    await page.evaluate(`window.__game.forceEffect(${kind})`)

    // Telegraph is 3 s of real time; drive it and then sit in the active phase.
    await page.waitForTimeout(3600)
    const during = await page.evaluate('window.__game.weatherProbe()')
    // Point the camera at the effect. A screenshot that does not contain the
    // thing it claims to show is not evidence — the first lava run photographed
    // an empty hillside while three vents erupted off-screen.
    const at = await page.evaluate('window.__game.hazardAt()')
    if (at) {
      await page.evaluate(`window.__game.place(${at.x}, ${at.y - 40})`)
      await page.waitForTimeout(700)
    }
    await page.screenshot({ path: join(shots, `m5-${name}.png`) })

    // Track the id we forced, not the kind: the real scheduler is running
    // alongside and may legitimately roll the same kind (overlap is allowed by
    // docs/13 §1), so "no effect of this kind" is the wrong question.
    const mine = during.active.find((a) => a.kind === name && !priorIds.has(a.id))
    check(`${name}: reached the active phase`, mine?.phase === 'active',
      JSON.stringify(during.active))

    if (name === 'toxic') {
      // Polled, not read once 600 ms into the active phase.
      //
      // A drop is a projectile (§C21): it leaves the cloud at `SKY_MARGIN` and
      // only lands where it stops, so the wait is however long the fall takes —
      // a property of the *map*, not of the effect. Under `MAP_GENERATOR=v2` the
      // ground sits ~880 px below the cloud instead of ~200, and a single read at
      // 0.6 s saw nothing and called it a failure. The active window is
      // TOXIC_DURATION (8 s); 4 s of polling is well inside it.
      //
      // **What is polled is the carve.** §E13 removed the puddles, so the
      // landing has no lingering object to count — the bullet-sized bite it
      // takes out of the ground is the evidence that a drop finished falling,
      // and it is a stronger one, because it is measured on the map rather than
      // on a list the effect keeps.
      let dug = 0
      for (let t = 0; dug === 0 && t < 20; t++) {
        await page.waitForTimeout(200)
        const now = await page.evaluate('window.__game.weatherProbe()')
        dug = before.solid - now.solid
      }
      check('toxic: drops landed and bit the ground', dug > 0, `${dug} px removed`)
      // ...and it is a bite, not a crater. `TOXIC_DROP_CARVE_R` is 6 px, so 20
      // drops can remove at most ~20·π·6² ≈ 2300 px; a meteor's 50 px crater
      // clears that in a single impact. Both ends, against the constants.
      const c = await page.evaluate('window.__game.constants()')
      const ceiling = 2 * Math.PI * c.TOXIC_DROP_CARVE_R ** 2 * (8 / 0.4)
      check('toxic: bites, never craters', dug < ceiling, `${dug} px vs a ${ceiling.toFixed(0)} px ceiling`)
    }
    if (name === 'meteor') {
      await page.waitForTimeout(2500)
      const later = await page.evaluate('window.__game.weatherProbe()')
      check('meteor: reshaped the map', later.solid < before.solid,
        `${before.solid} -> ${later.solid} solid px`)
    }
    if (name === 'lava') {
      const later = await page.evaluate('window.__game.weatherProbe()')
      check('lava: vents opened', later.vents > 0, `${later.vents} vents`)
      check('lava: carved channels', later.solid < before.solid,
        `${before.solid} -> ${later.solid} solid px`)
    }
    if (name === 'fog') {
      check('fog: cut the field of view', during.fov < before.fov,
        `fov ${Math.round(before.fov)} -> ${Math.round(during.fov)}`)
    }

    // Let it finish so the next effect starts from a clean slate.
    await page.waitForTimeout(name === 'fog' ? 16000 : 11000)
    const after = await page.evaluate('window.__game.weatherProbe()')
    check(`${name}: ran to completion`,
      mine === undefined || !after.active.some((a) => a.id === mine.id),
      JSON.stringify(after.active))
  }

  check('no page errors', errors.length === 0, errors.join('; '))
} finally {
  await browser.close()
  killGroup(vite.p)
}

console.log(failures === 0 ? '\nM5 checkpoint: all checks passed' : `\nM5 checkpoint: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
