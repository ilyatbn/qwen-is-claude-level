/**
 * T10.03 + T10.04 + T18.01: the title screen, its backdrop, and the menu.
 *
 * §B3 asked for a live round behind the title as a visible smoke test of
 * `game-core`. **§E9 overrides that**, so what is asserted here changed with it:
 * not "the simulation is running" but **"the menu survives the background"**.
 * The measured defect was that a throw inside `update()` removed the DOM and
 * stopped Phaser's frame loop, so the button died with the picture — one
 * failure, not two.
 *
 * Two claims, and neither can be reached by the unit suite: `environment: 'node'`
 * has no font engine and no canvas, so a green `npm test` says nothing about
 * which face rendered or whether anything was drawn. D-26 is why that is written
 * down rather than assumed.
 */
import { samplePatch } from './pixels.mjs'

export default async function ({ page, shot, log }) {
  // --- §E7: the title is SHRED, in the display face ------------------------
  //
  // **Sampled pixels, with a control region of body text in the same frame**
  // (`docs/72` §C2). The unit suite cannot reach this at all — `environment:
  // 'node'` has no font engine — so a green `npm test` says nothing about which
  // face rendered. D-26 is why that is written down rather than assumed.
  await page.waitForSelector('#game-title', { timeout: 30_000 })
  const title = await page.textContent('#game-title')
  if (title?.trim() !== 'SHRED') throw new Error(`the title reads "${title}", not SHRED`)
  if (await page.$('.tagline')) throw new Error('the tagline is still on the title screen')

  // The face has to have *loaded*, not merely been asked for: `font-display:swap`
  // renders the fallback until it arrives, so a missing file looks like a slow
  // one. `document.fonts.check` answers about the real face.
  await page
    .waitForFunction("document.fonts.check(\"16px 'KenneyFutureNarrow'\")", null, {
      timeout: 20_000,
    })
    .catch(() => {
      throw new Error('the display face never loaded — the title is in the fallback stack')
    })

  // And it is *used*: the rendered box differs from the same string set in the
  // body font. Two faces at one size produce different advance widths, so this
  // measures what was drawn rather than what was requested.
  const faces = await page.evaluate(() => {
    const probe = (family) => {
      const el = document.createElement('span')
      el.textContent = 'SHRED'
      el.style.cssText = `position:fixed;left:-9999px;font-size:64px;font-family:${family}`
      document.body.appendChild(el)
      const w = el.getBoundingClientRect().width
      el.remove()
      return w
    }
    const h1 = document.querySelector('#game-title')
    return {
      display: probe("'KenneyFutureNarrow'"),
      // The control: the same glyphs, same size, body font.
      body: probe('serif'),
      applied: getComputedStyle(h1).fontFamily,
    }
  })
  if (!faces.applied.includes('KenneyFutureNarrow')) {
    throw new Error(`the title is set in ${faces.applied}, not the display face`)
  }
  if (Math.abs(faces.display - faces.body) < 1) {
    throw new Error(
      `the display face measures the same as the body font ` +
        `(${faces.display.toFixed(1)} vs ${faces.body.toFixed(1)}): the face did not apply`,
    )
  }
  log(`title: SHRED in the display face (${faces.display.toFixed(0)}px vs body ${faces.body.toFixed(0)}px)`)
  await shot('title-shred')

  await page.waitForFunction('window.__title.debug().frames > 0', { timeout: 60_000 })
  const d = () => page.evaluate('window.__title.debug()')

  // --- the backdrop draws something (§C2) ---------------------------------
  //
  // **A layer toggle inside one frame**, not a before/after across two moments.
  // The sky walks a day cycle, so two frames a second apart differ whether or
  // not the backdrop exists — that comparison would pass for a blank canvas
  // under a moving gradient. Hiding the layer and diffing the same frame against
  // itself isolates what the backdrop contributes and nothing else, which is how
  // `birds` and `living-sky` measure their layers.
  const first = await d()
  if (!first.backdrop) {
    throw new Error(`no backdrop was built: ${first.reason ?? 'no reason given'}`)
  }
  const REGION = { x: 40, y: 40, w: 300, h: 200 }
  // Frozen first. The sky twinkles, drifts and interpolates its gradient, so two
  // samples a moment apart differ whether or not the backdrop exists — the
  // control below caught exactly that on the first run of this check.
  await page.evaluate('window.__title.freeze(true)')
  await page.waitForTimeout(150)
  const withSky = await samplePatch(page, REGION)
  const same = await samplePatch(page, REGION)
  // The control: the same frame, sampled twice, with nothing toggled. If this
  // differs, the diff below is measuring the day cycle rather than the layer.
  if (same.digest !== withSky.digest) {
    throw new Error('the same frame differs from itself — the backdrop diff below would be noise')
  }
  await page.evaluate('window.__title.setBackdropVisible(false)')
  const withoutSky = await samplePatch(page, REGION)
  await page.evaluate('window.__title.setBackdropVisible(true)')
  await page.evaluate('window.__title.freeze(false)')
  if (withoutSky.digest === withSky.digest) {
    throw new Error('hiding the backdrop changed nothing: the title screen is drawing a blank sky')
  }
  log(
    `backdrop: hiding it moved the region (lum ${withSky.lum.toFixed(1)} -> ` +
      `${withoutSky.lum.toFixed(1)}); the same frame differs from itself by 0`,
  )
  await shot('title')

  // --- and the menu survives it (§E9) -------------------------------------
  //
  // The acceptance criterion, stated as measurement: **the frame loop is still
  // running after the window the old bug died in.** `frames` is scene-level and
  // monotonic, so a frozen count is exactly what a throw escaping `update()`
  // looks like from outside — which is the failure that took the button with it.
  //
  // Sixty-one seconds because the old scene un-gated its warmup at about thirty
  // and rebuilt its world at forty-five; a check that waited less than both
  // would have passed against the code this replaces.
  const early = await d()
  if (early.frames <= 0) throw new Error('the scene never rendered a frame, so waiting proves nothing')
  if (!early.uiPresent) throw new Error('the Start button was gone within a second')

  await page.waitForTimeout(61_000)
  const late = await d()

  // **Growth alone is not the claim, and falsification proved it.** With an
  // unguarded throw put back into `update()` — the exact §E9 defect — this
  // counter still advanced, 1187 frames against 3660 for a healthy run: Phaser
  // kept calling a scene that threw, at a third of the rate. So a `>` test
  // passes for a loop the bug has crippled. It stays as the diagnostic that says
  // *how badly*, and the click below is the assertion that says *whether*.
  if (late.frames <= early.frames) {
    throw new Error(
      `the frame loop stopped dead: ${early.frames} -> ${late.frames} frames over 61 s ` +
        `(reason: ${late.reason ?? 'none reported'})`,
    )
  }
  if (!late.uiPresent) {
    throw new Error(`the Start button vanished after ${late.elapsed.toFixed(0)} s`)
  }
  if (!late.drawOk || !late.backdropOk) {
    throw new Error(`the backdrop failed while drawing: ${late.reason}`)
  }
  const fps = (late.frames - early.frames) / 61
  log(
    `menu survived: ${late.frames - early.frames} frames over 61 s (${fps.toFixed(0)}/s), ` +
      `button still there, backdrop still drawing`,
  )

  // **This is the acceptance criterion.** Everything above narrows *why* if it
  // fails; this is the only line that says the screen did its job. Verified by
  // falsification: an unguarded throw in `update()` sails past every assertion
  // above and dies here, because the button is present, the counter is moving,
  // and the click still never reaches the menu.
  await page.click('#start-game')
  await page
    .waitForFunction('window.__menu !== undefined', { timeout: 20_000 })
    .catch(() => {
      throw new Error(
        `the Start button did not reach the menu after ${late.elapsed.toFixed(0)} s ` +
          `(${fps.toFixed(0)} frames/s, backdrop ${late.drawOk ? 'drawing' : 'failed'})`,
      )
    })

  // --- the menu ------------------------------------------------------------
  const m = () => page.evaluate('window.__menu.debug()')
  const menu = await m()
  if (menu.screen !== 'menu') throw new Error(`menu opened on ${menu.screen}`)
  await shot('menu')

  // --- the Private Game screen (§E7) --------------------------------------
  //
  // Quick Game takes no options — a quick match randomises its settings — so
  // hosting and joining live behind Private Game.
  //
  // **A map-size stepper used to be asserted here and there is no longer one to
  // assert.** `4f28b2e` (owner, 2026-09-16) took the control off this screen:
  // it asked the question before the answer could matter, since a guest about
  // to press Join never owns the setting. That commit did not touch this file,
  // so what stood here spent five days waiting 30 s for `#scale-value` and
  // failing — nothing selected `title` in between, because `affected.mjs` only
  // reaches it when a client source file changes.
  //
  // **Where map size is asserted now**: `scripts/checks/lobby.mjs`, whose `IDS`
  // list carries `scale` through the host's panel, the guest's panel and the
  // seat gate (host's arrows enabled, guest's disabled). Its `MOVED` list —
  // `bots`, `kit`, `timer`, `gravity` — does *not* include `scale`, so no check
  // steps map size end-to-end; that half rests on `lobby.test.ts`, which pins
  // `stepSetting(…, 'scale', ±1)` wrapping in both directions. Said plainly
  // rather than left to be discovered: the wire half of a map-size change is
  // the one thing this move did not carry over.
  await page.click('#private')
  if ((await m()).screen !== 'private') throw new Error('Private Game did not open')

  // What the screen **is**: three buttons, each labelled and usable, and
  // nothing else. Asserted as a set rather than one id at a time so that it
  // reports both directions — a button that went missing, and a control that
  // came back.
  const WANT = [
    ['host', 'Host'],
    ['join', 'Join'],
    ['back', 'Back'],
  ]
  const buttons = await page.$$eval('.menu-screen .actions button', (els) =>
    els.map((b) => ({ id: b.id, label: (b.textContent ?? '').trim(), disabled: b.disabled })),
  )
  for (const [id, label] of WANT) {
    const b = buttons.find((x) => x.id === id)
    if (!b) {
      throw new Error(
        `the Private Game screen has no ${label} button (#${id}); it shows ` +
          `${JSON.stringify(buttons.map((x) => x.id))}`,
      )
    }
    if (b.label !== label) throw new Error(`#${id} reads "${b.label}", not "${label}"`)
    if (b.disabled) throw new Error(`the ${label} button is disabled, so nothing can press it`)
  }
  const extra = buttons.filter((b) => !WANT.some(([id]) => id === b.id))
  if (extra.length) {
    throw new Error(
      `the Private Game screen has controls nothing asserts: ` +
        `${JSON.stringify(extra.map((b) => b.id || b.label))}`,
    )
  }

  // And it navigates. Back is clicked rather than driven from the keyboard
  // because Esc is asserted below and the two are separate bindings; Host is
  // not clicked here — this check runs no game server, and `lobby.mjs` presses
  // it against a real one to host a real room.
  await page.click('#back')
  if ((await m()).screen !== 'menu') throw new Error('Back did not return to the menu')
  await page.click('#private')
  if ((await m()).screen !== 'private') throw new Error('Private Game did not reopen')
  log(`private game: ${buttons.map((b) => b.label).join(', ')}; Back returns to the menu`)

  // The join screen, and a bad code named locally rather than round-tripped.
  await page.click('#join')
  await page.fill('#code', 'ABCD0Z')
  await page.click('#go')
  const err = (await m()).error
  if (!err || !err.includes('0')) {
    throw new Error(`expected a message naming the bad character, got ${err}`)
  }
  // And it must keep what was typed, or fixing one character means retyping six.
  if ((await m()).code !== 'ABCD0Z') throw new Error('the typed code was cleared')
  log(`join: rejected locally — "${err}"`)
  await shot('menu-join')

  // Esc goes back, one level at a time (§E7 nests Host and Join under Private).
  await page.keyboard.press('Escape')
  if ((await m()).screen !== 'private') throw new Error('Esc did not go back one level')
  await page.keyboard.press('Escape')
  if ((await m()).screen !== 'menu') throw new Error('Esc did not reach the menu')

  return 'ok'
}
