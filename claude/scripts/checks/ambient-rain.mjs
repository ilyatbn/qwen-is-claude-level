#!/usr/bin/env node
/**
 * T21.26 — ambient rain, in the scene a player is actually in.
 *
 *   node scripts/checks/ambient-rain.mjs
 *
 * The ask: a rain that is *"just effects"*, not green and not an event. The
 * failure mode to design against is a player seeing rain and not knowing whether
 * to run. So this asserts the two sheets **look different on the screen**, not
 * that two colour constants differ — a constant that nothing carried to the frame
 * is the §A15 trap this project keeps paying for.
 *
 * ## How a sheet's colour is measured
 *
 * Rain is thin streaks over whatever is behind them, so a patch's mean colour is
 * mostly sky. What a sheet *contributes* is isolated the way `teleport` isolates a
 * gate: freeze the scene, photograph the patch with the sheet shown and then
 * hidden (the other rain hidden in both), and take the difference. Frozen, the
 * only thing that changes between the two photographs is that one layer — and a
 * second photograph of the shown state measures the noise floor directly.
 *
 * ## Both ends (§A39)
 *
 * The schedule is Rust's and is unit-tested there over 200 seeds. What this
 * asserts is the hop: the schedule said rain (`ambientAsked`) and the sheet drew
 * (`ambientDrops`), with the control that before it said rain, nothing was drawn.
 */
import { startStack, enterBattle, tally, freePort } from './harness.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('ambient-rain')

/**
 * Where streaks are counted: below the HUD strip, clear of the banner and clock.
 * Rain is screen-space, so any band will do.
 */
const BAND = { x: 200, y: 70, w: 880, h: 260 }
/**
 * A pixel counts as changed when any channel moved by more than this.
 *
 * **Counted per pixel, not averaged over a patch — measured, the first version was
 * blind.** Rain is thin streaks: a patch mean moved 1.2 for the toxic sheet and
 * **0.0** for a visible ambient sheet, because 22 one-and-a-half-pixel lines vanish
 * into a 400x160 average. Frozen, two photographs of one frame differ by nothing,
 * so any threshold above zero separates the layer from the noise; 8 is below the
 * smallest streak (grey-blue over bright sky moves a pixel ~19) and the noise
 * count is measured anyway.
 */
const THRESH = 8

const stack = await startStack({
  port: PORT,
  label: 'ambient-rain',
  env: {
    // Toxic so both sheets can be photographed in one round; seed pinned so the
    // ambient schedule is the same every run.
    WEATHER: 'toxic',
    BOT_COUNT: '0',
    LOBBY_BOT_TIMEOUT: '3',
    FIXED_SEED: '1',
    ROUND_SECONDS: '300',
  },
})
const { page, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'ambient-rain' })

const read = () =>
  page.evaluate(() => {
    const d = window.__game.debug()
    return {
      t: d.roundTime ?? 0,
      asked: d.ambientAsked,
      drops: d.ambientDrops,
      pool: d.ambientPool,
      toxicDrawn: d.rainDrops,
      kinds: [...new Set((d.observed?.effects ?? []).map((e) => String(e.kind)))],
    }
  })

const norm = (v) => Math.hypot(v[0], v[1], v[2])
const cosine = (u, v) => (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (norm(u) * norm(v) || 1)
const fmt = (v) => `(${v.map((x) => x.toFixed(1)).join(', ')})`

const grab = async () =>
  (await page.screenshot({ clip: { x: BAND.x, y: BAND.y, width: BAND.w, height: BAND.h } })).toString('base64')

/** Pixels that differ between two photographs, and their mean change (a - b). */
const compare = (a, b) =>
  page.evaluate(
    async ([sa, sb, thr]) => {
      const load = async (src) => {
        const img = new Image()
        img.src = `data:image/png;base64,${src}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, img.width, img.height).data
      }
      const A = await load(sa)
      const B = await load(sb)
      let changed = 0
      let dr = 0
      let dg = 0
      let db = 0
      for (let i = 0; i < A.length; i += 4) {
        const r = A[i] - B[i]
        const g = A[i + 1] - B[i + 1]
        const bl = A[i + 2] - B[i + 2]
        if (Math.max(Math.abs(r), Math.abs(g), Math.abs(bl)) > thr) {
          changed++
          dr += r
          dg += g
          db += bl
        }
      }
      return {
        changed,
        total: A.length / 4,
        delta: changed ? [dr / changed, dg / changed, db / changed] : [0, 0, 0],
      }
    },
    [a, b, THRESH],
  )

/** Freeze; photograph the band with `which` shown and hidden, the other rain hidden. */
async function isolate(which) {
  const other = which === 'toxic' ? 'ambient' : 'toxic'
  await page.evaluate(() => window.__game.freeze(true))
  try {
    await page.evaluate((o) => window.__game.setRainVisible(o, false), other)
    const shown = await page.evaluate((w) => window.__game.setRainVisible(w, true), which)
    const on = await grab()
    const again = await grab()
    const hidden = await page.evaluate((w) => window.__game.setRainVisible(w, false), which)
    const off = await grab()
    const layer = await compare(on, off)
    const noise = await compare(on, again)
    return {
      ...layer,
      noiseChanged: noise.changed,
      toggled: shown.visible === true && hidden.visible === false,
    }
  } finally {
    await page.evaluate(() => {
      window.__game.setRainVisible('toxic', true)
      window.__game.setRainVisible('ambient', true)
    })
    await page.evaluate(() => window.__game.freeze(false))
  }
}

// --- the control: no ambient sheet drawn while the schedule says dry ----------
const start = await read()
if (start.asked === 0 && start.drops !== 0) {
  fail(`the schedule says dry and the ambient sheet still drew ${start.drops} droplets`)
} else ok(`start: schedule ${start.asked.toFixed(2)}, ambient droplets ${start.drops} of ${start.pool}`)

// --- the toxic sheet, for the colour the ambient one must not be mistaken for --
const toxicUp = await page
  .waitForFunction('window.__game.debug().rainDrops > 60', null, { timeout: 120_000 })
  .then(() => true)
  .catch(() => false)
let toxic = null
if (!toxicUp) fail('the toxic sheet never drew — there is nothing to compare the ambient rain against')
else {
  toxic = await isolate('toxic')
  await shot('ambient-rain-toxic')
  console.log(`  toxic sheet: ${toxic.changed} of ${toxic.total} px changed, mean change ${fmt(toxic.delta)}, noise ${toxic.noiseChanged} px`)
}

// --- the ambient sheet, on its own schedule -----------------------------------
// Waited on the schedule's own number reaching the layer, in the simulation's
// clock (T21.23) — never a sleep against `AMBIENT_RAIN_WINDOW`.
const ambientUp = await page
  // At **full** strength: photographed on its first droplets the sheet is a
  // ramp's worth of faint lines, which is a measurement of the ramp.
  .waitForFunction(
    'window.__game.debug().ambientAsked >= 0.99 && window.__game.debug().ambientIntensity >= 0.99',
    null,
    { timeout: 240_000 },
  )
  .then(() => true)
  .catch(() => false)
let ambient = null
if (!ambientUp) {
  const s = await read()
  fail(`no ambient rain drew by round time ${s.t.toFixed(1)} (schedule ${s.asked})`)
} else {
  const s = await read()
  // Both ends: the sheet is drawing because the schedule asked for it.
  if (!(s.asked > 0)) fail(`the ambient sheet drew ${s.drops} droplets while the schedule said ${s.asked}`)
  else ok(`round time ${s.t.toFixed(1)}: the schedule asked ${s.asked.toFixed(2)} and ${s.drops} droplets drew`)
  ambient = await isolate('ambient')
  await shot('ambient-rain-ambient')
  console.log(`  ambient sheet: ${ambient.changed} of ${ambient.total} px changed, mean change ${fmt(ambient.delta)}, noise ${ambient.noiseChanged} px`)
}

// --- the pixels ---------------------------------------------------------------
const visible = {}
for (const [name, m] of [
  ['toxic', toxic],
  ['ambient', ambient],
]) {
  if (!m) continue
  if (!m.toggled) fail(`${name}: the visibility hook did not read back what it was asked`)
  const floor = Math.max(200, m.noiseChanged * 3)
  visible[name] = m.changed > floor
  if (!visible[name]) {
    fail(`${name}: the sheet changed ${m.changed} px against a floor of ${floor} — not on screen`)
  } else ok(`${name}: the sheet is on the screen (${m.changed} px changed, floor ${floor})`)
}
if (visible.toxic && visible.ambient) {
  const c = cosine(toxic.delta, ambient.delta)
  const greenLead = (v) => v[1] - Math.max(v[0], v[2])
  console.log(
    `  green lead: toxic ${greenLead(toxic.delta).toFixed(1)}, ambient ${greenLead(ambient.delta).toFixed(1)}; ` +
      `direction agreement (cosine, logged only) ${c.toFixed(3)}`,
  )
  // **The claim is the green, not the angle.** What tells a player "run" is that the
  // hazard's rain is green; the ambient sheet's colour (`AMBIENT_RAIN_COLOUR`, blue >
  // green > red) cannot lead with green over any background. A cosine between the
  // two changes was tried first and is logged rather than asserted: measured 0.837
  // against a 0.9 bar, and its value swings with how much of the band is sky versus
  // rock, which is a property of the camera rather than of either sheet.
  if (!(greenLead(toxic.delta) > 0)) {
    fail(`the toxic sheet's change ${fmt(toxic.delta)} is not green-led — the comparison has no anchor`)
  } else ok(`the toxic sheet reads green (lead ${greenLead(toxic.delta).toFixed(1)})`)
  if (!(greenLead(ambient.delta) < 0)) {
    fail(`the ambient sheet's change ${fmt(ambient.delta)} is green-led — it reads as the hazard`)
  } else ok(`the ambient sheet does not read green (lead ${greenLead(ambient.delta).toFixed(1)}) — a player can tell them apart`)
} else if (toxic || ambient) {
  // Not an `ok`: a colour comparison against a sheet that is not on screen would
  // pass for the wrong reason, which is exactly what the first run of this did.
  console.log('  colour comparison skipped — both sheets must be on screen first (failed above)')
}

// --- not an event ---------------------------------------------------------------
// `WEATHER=toxic` forces the scheduler to pick rain, so every effect this client
// was told about is the toxic one. An ambient rain announced as an effect would be
// a second kind here.
const end = await read()
if (end.kinds.length > 1) fail(`the client saw more than one effect kind: ${end.kinds.join(', ')}`)
else ok(`effects announced: ${end.kinds.join(', ') || 'none'} — the ambient rain was never one of them`)

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
