#!/usr/bin/env node
/**
 * T21.24 — the optional FPS counter, **in the game**, asserted on rendered
 * pixels.
 *
 *   node scripts/checks/fps-counter.mjs
 *   node scripts/e2e.mjs fps-counter
 *
 * The counter exists because a person could not tell, in a real browser, whether
 * High Quality fog costs anything on their machine. So it is an instrument for a
 * human eye, and the only assertion that means anything about it is one about
 * what a human eye would see.
 *
 * ## Why this is standalone and networked
 *
 * The counter lives on `GameScene`'s HUD, and the sandbox has its own debug HUD
 * — the thing that was explicitly *not* what was asked for. A sandbox check
 * would therefore pass on a build where `GameScene` never created the element,
 * which is §C0's shape: `ordnance.update` was driven by the sandbox alone and
 * `GameScene` drew no projectiles at all for three milestones with a green
 * suite.
 *
 * ## What each assertion rules out
 *
 * - **Pixels, not `debug()`** (`docs/72` §C2). A handle reporting `fpsCounter:
 *   true` is satisfied by an element that is `display:none`, sized 0x0, behind
 *   the HUD, or drawn in the background colour. Four "I cannot see it" bugs
 *   shipped past 905 tests on exactly that substitution.
 * - **A control region that shares the subject's background** — see `NEIGHBOUR`,
 *   which is where the first version of this check was wrong and was caught by
 *   its own falsification. A control somewhere else on the screen cannot see the
 *   thing that fools the subject.
 * - **A control frame**: the *same* rectangle, photographed with the setting on
 *   and with it off, with nothing else touched — and taken with the options
 *   panel left open so the two frames are ~0.4 s apart rather than 1.4 s.
 * - **The number is read off the element's own text**, which is the thing the
 *   player reads. Bounded rather than pinned — a pinned frame rate is a wait
 *   against a tunable by another name (§A28), and the box's real rate is not
 *   this repository's business. `NaN fps` and `0 fps` are what the bound exists
 *   to catch.
 * - **The reload leg is the one that tests `loadSettings`.** T21.16 shipped a
 *   setting nothing read at boot and its gate passed, because nothing consumed
 *   the value. Here the page is reloaded with the setting stored and the counter
 *   has to come back **without anyone opening the panel** — which is false for
 *   any build that forgets the read.
 */
import { startStack, enterBattle, tally, sleep } from './harness.mjs'
import { samplePatch, assertChanged, colourDelta } from './pixels.mjs'

/**
 * A plausible frame rate, as a bracket rather than a target.
 *
 * The upper bound is loose on purpose — a 240 Hz monitor is a real thing and
 * this must not fail on one. The lower bound is the assertion that actually
 * earns its place: it is what fails for `0 fps` (a meter that was never fed) and
 * for `NaN fps` (a meter fed rubbish), which are the two ways this element can
 * exist, be visible, and say nothing true.
 */
const FPS_MIN = 1
const FPS_MAX = 400

const PORT = 3133
const { fail, ok, finish } = tally('fps-counter')

const stack = await startStack({
  port: PORT,
  label: 'fps-counter',
  env: { ROUND_SECONDS: '300', BOT_COUNT: '0', DEV_LOADOUT: '1' },
})
const { page, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'fps-counter' })

/** The counter's on-screen rectangle, or null when it is not drawn. */
const counterBox = () =>
  page.evaluate(() => {
    const el = document.getElementById('fps-counter')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const vis = getComputedStyle(el).display !== 'none'
    return { x: r.x, y: r.y, w: r.width, h: r.height, vis, text: el.textContent ?? '' }
  })

const openOptions = async () => {
  await page.keyboard.press('Escape')
  await sleep(250)
  await page.evaluate(() => document.getElementById('escape-options')?.click())
  await sleep(200)
}
const closeOptions = async () => {
  await page.evaluate(() => document.getElementById('options-close')?.click())
  await sleep(120)
  await page.keyboard.press('Escape')
  await sleep(250)
}

// --- 1. the default is off, and the panel says so --------------------------
const atStart = await counterBox()
if (atStart && atStart.vis && atStart.w > 1) {
  fail(`the FPS counter is on the screen before anyone asked for it ("${atStart.text}")`)
} else {
  ok('control: the counter is not drawn by default')
}

await openOptions()
const label0 = await page.evaluate(
  () => document.getElementById('options-fps')?.textContent ?? null,
)
if (label0 === null) {
  fail('there is no #options-fps button in the options panel')
} else if (label0 !== 'Off') {
  fail(`the FPS counter option reads "${label0}" — it must default to Off`)
} else {
  ok('the options panel has an FPS counter button and it reads Off')
}
await shot('fps-counter-options')

// --- 2. turning it on puts it on the screen, live ---------------------------
//
// **Live, with no reload.** The panel is still open when the click lands and the
// element has to exist by the time the panel is closed again; a toggle that
// waited for a reload would satisfy the reload leg below and fail here, which is
// the whole reason both legs are present.
await page.evaluate(() => document.getElementById('options-fps')?.click())
await sleep(150)
const label1 = await page.evaluate(
  () => document.getElementById('options-fps')?.textContent ?? '',
)
if (label1 !== 'On') fail(`the FPS button read "${label1}" after a click`)
await closeOptions()
await sleep(400)

const box = await counterBox()
if (!box || !box.vis || box.w < 1 || box.h < 1) {
  fail(`turning the option on drew no counter (${JSON.stringify(box)})`)
  await shot('fps-counter-missing')
  if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
  await finish(() => stack.close())
}
ok(`the counter is laid out at ${box.x},${box.y} ${box.w.toFixed(0)}x${box.h.toFixed(0)}`)

/**
 * The rectangle both frames are sampled from.
 *
 * Taken from the element while it is visible and then **held fixed**, because
 * when it is off it has no rectangle at all — a region that moved between the
 * two samples would be comparing two different parts of the screen.
 */
const SUBJECT = {
  x: Math.max(0, Math.round(box.x) - 2),
  y: Math.max(0, Math.round(box.y) - 2),
  w: Math.max(8, Math.round(box.w) + 4),
  h: Math.max(8, Math.round(box.h) + 4),
}

// It must not be sitting on the HUD. Asserted against the elements that are
// actually on the screen rather than against remembered coordinates.
const overlaps = await page.evaluate((s) => {
  const hit = []
  for (const id of ['game-hud', 'hud-timer', 'hud-banner', 'hud-bars', 'jetpack-readout',
                    'inventory-bar', 'debug-fps']) {
    const el = document.getElementById(id)
    if (!el) continue
    if (getComputedStyle(el).display === 'none') continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    if (r.left < s.x + s.w && r.right > s.x && r.top < s.y + s.h && r.bottom > s.y) hit.push(id)
  }
  return hit
}, SUBJECT)
if (overlaps.length) fail(`the counter overlaps the HUD: ${overlaps.join(', ')}`)
else ok('and it is clear of every HUD element on the screen')

/**
 * The control **region**: the same band, one counter-width to the right.
 *
 * This was `FIELD` — a patch of ground low on the left — and the first
 * falsification went straight through it. Planting `opacity:0` on the counter,
 * so the element is laid out, carries its text, reports a plausible rate and
 * paints nothing, still produced `the region changed 10.8, control 0.7` and this
 * check said ok. The 10.8 was **the sky**, drifting over the 1.4 s between the
 * two frames as the round's day cycle ran; a control on the ground cannot
 * register that, because ground does not change colour when the sky does.
 *
 * So the control moved next to the subject, where the same daylight reaches it.
 * Its absolute colour is **not** expected to match the subject's — measured, the
 * two rectangles sit on different terrain and differ by 70-90 either way — which
 * is exactly why the assertion below is about how much each one *moved* and
 * never about how far apart they are.
 */
const NEIGHBOUR = { x: SUBJECT.x + SUBJECT.w + 16, y: SUBJECT.y, w: SUBJECT.w, h: SUBJECT.h }

/**
 * How many times the toggle's effect must exceed the frame's own drift.
 *
 * The **control frame**, and the assertion the plant above cannot survive. The
 * subject rectangle is photographed twice with nothing touched, which measures
 * what this region does on its own over the same interval; the toggle then has
 * to move it by more than that, by a margin. With the counter invisible the two
 * numbers are the same thing measured twice and the ratio collapses to 1.
 *
 * Three rather than two, because the noise floor is itself one sample of a
 * noisy quantity. The measured signal is an order of magnitude clear of it.
 */
const SIGNAL_TO_DRIFT = 3

// --- 3. a plausible number, read off the text the player reads --------------
const text = (await counterBox())?.text ?? ''
const n = Number(/(-?[\d.]+)/.exec(text)?.[1] ?? 'x')
if (!Number.isFinite(n)) {
  fail(`the counter reads "${text}", which contains no number`)
} else if (n < FPS_MIN || n > FPS_MAX) {
  fail(`the counter reads "${text}" — ${n} is not a frame rate`)
} else {
  ok(`it reads a plausible rate: "${text}"`)
}
// Rounded, as asked: a number flickering through three decimals is unreadable.
if (/\.\d/.test(text)) fail(`the counter shows decimals ("${text}") — it has to be rounded`)

// --- 4. the pixels: a control frame, then the toggle ------------------------
//
// **The panel stays open across all three frames.** It is centred and 320 px
// wide, so it covers none of the top-left corner, and leaving it up removes two
// Esc presses and two waits from between the samples — drift the control would
// otherwise have to absorb.
await openOptions()
await sleep(350)
// The control frame: the same rectangle, the same interval, nothing toggled.
const beforeSubject = await samplePatch(page, SUBJECT)
const beforeNeighbour = await samplePatch(page, NEIGHBOUR)
await sleep(350)
const onSubject = await samplePatch(page, SUBJECT)
const onNeighbour = await samplePatch(page, NEIGHBOUR)
await shot('fps-counter-on')

await page.evaluate(() => document.getElementById('options-fps')?.click())
const label2 = await page.evaluate(
  () => document.getElementById('options-fps')?.textContent ?? '',
)
if (label2 !== 'Off') fail(`the FPS button read "${label2}" after a second click`)
await sleep(350)
const offSubject = await samplePatch(page, SUBJECT)
const offNeighbour = await samplePatch(page, NEIGHBOUR)
await shot('fps-counter-off')
await closeOptions()

/** What the subject rectangle does over one interval with nothing touched. */
const drift = colourDelta(beforeSubject, onSubject)
/** What it does over the same interval with the setting flipped. */
const signal = colourDelta(onSubject, offSubject)
const px = (p) => `rgb(${p.r.toFixed(1)},${p.g.toFixed(1)},${p.b.toFixed(1)}) sd ${p.sd.toFixed(1)}`
console.log(
  `  counter on, control frame: subject ${px(beforeSubject)} | control ${px(beforeNeighbour)}\n` +
    `  counter on              : subject ${px(onSubject)} | control ${px(onNeighbour)}\n` +
    `  counter off             : subject ${px(offSubject)} | control ${px(offNeighbour)}\n` +
    `  subject drift with nothing touched ${drift.toFixed(1)}; with the toggle ${signal.toFixed(1)}`,
)

// (a) the toggle's effect against the frame's own measured noise floor.
if (signal < drift * SIGNAL_TO_DRIFT) {
  fail(
    `turning the counter off moved its rectangle by ${signal.toFixed(1)}, against ${drift.toFixed(1)} ` +
      `for the same rectangle over the same interval with nothing touched — under ${SIGNAL_TO_DRIFT}x ` +
      `the noise floor. That is the frame changing on its own, not the counter disappearing`,
  )
} else {
  ok(
    `turning it off moved its rectangle ${signal.toFixed(1)}, against a measured noise floor of ` +
      `${drift.toFixed(1)} for the same rectangle with nothing touched`,
  )
}

// (b) and the same claim through the shared harness, with the control region
//     that shares the subject's daylight.
try {
  const r = assertChanged(onSubject, offSubject, {
    label: 'the FPS counter region',
    control: { before: onNeighbour, after: offNeighbour },
  })
  ok(
    `and the patch beside it moved only ${r.controlDelta.toFixed(1)} over the same two frames ` +
      `(subject ${r.delta.toFixed(1)})`,
  )
} catch (e) {
  fail(String(e.message ?? e))
}

// --- 5. it survives a reload, which is the assertion about `loadSettings` ----
await openOptions()
await page.evaluate(() => document.getElementById('options-fps')?.click())
await closeOptions()
await page.reload()
await page.waitForFunction(
  'window.__game && typeof window.__game.debug().phase === "string" && window.__game.debug().me >= 0',
  null,
  { timeout: 120_000 },
)
await enterBattle(page, { waitPlaying: true, label: 'fps-counter (after reload)' })
await sleep(600)
const afterReload = await counterBox()
if (!afterReload || !afterReload.vis || afterReload.w < 1) {
  fail(
    'the counter did not come back after a reload — the stored setting is never read at ' +
      'boot, so it silently reverts to off (T21.16 shipped exactly this)',
  )
} else {
  ok(`the setting survives a reload — the counter is back, reading "${afterReload.text}"`)
}
await shot('fps-counter-reload')

// And the panel agrees with the screen rather than with its own default.
await openOptions()
const label3 = await page.evaluate(
  () => document.getElementById('options-fps')?.textContent ?? '',
)
if (label3 !== 'On') fail(`after a reload the panel reads "${label3}", not the stored On`)
else ok('and the panel paints itself from the stored value')

// Leave it as it was found, so a later check does not inherit it.
await page.evaluate(() => document.getElementById('options-fps')?.click())
await closeOptions()

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
