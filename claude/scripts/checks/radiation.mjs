/**
 * T22.09B — **a player can tell space's radiation is getting through** (`M22-RULINGS`
 * R6: *"it is not silent"*). The suit's feedback, asserted on the rendered frame
 * (`docs/72` §C2), in the sandbox at `?gravity=space` (R22):
 *
 *  - **subject region** — a strip at the right edge of the screen, mid-height, where
 *    the radiation glow is drawn (clear of the sandbox panel top-left, the kill feed
 *    top-right and the minimap bottom-right);
 *  - **control region** — a patch above the centre of the screen, which the glow must
 *    never tint: the player is looking there;
 *  - **control frame** — the same scene with the suit **sealed**. The suit is emptied
 *    through `Core.addBattery` (`PlayerState::add_battery`'s clamp) and refilled by a
 *    pack's worth, so the only thing that differs between the photographs is the seal.
 *
 * Unsealed is **read through `Core.irradiated`** — the Rust predicate snapshot bit 7 is
 * encoded from — not assumed from having emptied the battery. And the seal at load is
 * asserted before anything is touched: review F11 was a sandbox that seated a space
 * player in a flat suit, which a real player never is.
 *
 * The HUD line is asserted the same way, on its own box: the quiet "sealed" line and
 * the loud "RADIATION" one are different pictures in the same place.
 *
 * `radiation-standard` runs this file at `?gravity=standard` for the absence: an empty
 * battery outside space draws nothing, with the space entry as its presence control.
 *
 * Every wait counts drawn frames or polls on animation frames; none waits a wall-clock
 * interval against a tunable.
 */
import { deadlineMs } from '../lib/deadline.mjs'
import { constants as rustConstants } from '../lib/rust-constants.mjs'
import { samplePatch, assertChanged, assertUnchanged, photo, comparePhotos, toScreen } from './pixels.mjs'
import { drawnFrames } from './harness.mjs'

/** Frames drawn after a state change before photographing it. */
const SETTLE_FRAMES = 6
/**
 * A viewport narrower than the RADIATION line was wide before F8 (~550 px at the
 * loud size). The line must wrap inside it, not run off the right edge.
 */
const NARROW_VIEWPORT_W = 480

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export default async function ({ page, shot, log }) {
  const dbg = () => page.evaluate(() => window.__game.debug())
  const waitFor = async (fn, arg, why, seconds = 20) => {
    try {
      await page.waitForFunction(fn, arg, { timeout: deadlineMs(seconds, why), polling: 'raf' })
    } catch (e) {
      if (String(e).includes('Timeout')) throw new Error(`${why} (waited ${seconds}s)`)
      throw e
    }
  }
  /** `n` drawn frames, or a throw naming a page that stopped rendering — the harness's one copy (T22.00C). */
  const frames = (n) => drawnFrames(page, n)
  /** The Rust answer, asked with the sandbox's own clock (R26: never a literal `now`). */
  const irradiated = () => page.evaluate(() => window.__game.core.irradiated(0, window.__game.debug().simTime))
  const setBattery = (delta) => page.evaluate((d) => window.__game.core.addBattery(0, d), delta)

  const k = await page.evaluate(() => window.__game.constants())
  await waitFor(() => !!window.__game.debug().player, null, 'the sandbox never produced a local player')
  const gravity = new URL(page.url()).searchParams.get('gravity')
  const rocks = await page.evaluate(() => window.__game.core.meta.asteroids.length)

  if (gravity === 'standard') {
    // The absence. The rocks prove it is not a space map in disguise; the battery is
    // emptied anyway, so "nothing drawn" is not "the suit happened to be charged".
    if (rocks !== 0) throw new Error(`?gravity=standard generated ${rocks} asteroids — this is a space map`)
    await setBattery(-k.BATTERY_MAX)
    await frames(SETTLE_FRAMES)
    const d = await dbg()
    if (await irradiated()) throw new Error('outside space, Core.irradiated says radiation is getting through')
    if (d.radiation?.state !== 'none' || d.radiation.edgeOpacity !== 0 || d.radiation.line !== null) {
      throw new Error(`outside space with an empty battery, the suit feedback is up: ${JSON.stringify(d.radiation)}`)
    }
    await shot('radiation-standard')
    log('standard gravity, empty battery: no radiation, no glow, no suit line')
    return
  }
  if (rocks === 0) throw new Error('no asteroids — `?gravity=space` did not reach the scene')

  // The same light and the same camera in every photograph.
  await page.evaluate(() => {
    window.__game.setTime(0)
    window.__game.setParallaxClock(0)
    const p = window.__game.debug().player
    window.__game.watch(p.x, p.y)
  })
  await frames(SETTLE_FRAMES)

  // --- sealed: the control frame -------------------------------------------------
  // F11, before anything is touched: seated in space, the suit is issued full.
  if (await irradiated()) throw new Error('a sandbox player seated in space starts irradiated — the suit was not issued (F11)')
  const sealed = await dbg()
  if (sealed.radiation?.state !== 'sealed' || sealed.radiation.edgeOpacity !== 0) {
    throw new Error(`control: a sealed suit should show the quiet line and no glow: ${JSON.stringify(sealed.radiation)}`)
  }
  if (!/softens every hit/.test(sealed.radiation.line ?? '')) {
    throw new Error(`the sealed line does not say the suit softens hits (F4): ${JSON.stringify(sealed.radiation.line)}`)
  }
  // R26: the suit is not the generator's bubble.
  if (await page.evaluate(() => window.__game.core.shieldActive(0, window.__game.debug().simTime))) {
    throw new Error('a sealed suit with no generator lights shieldActive — the bubble would draw')
  }
  log(`sealed: "${sealed.radiation.line}"`)

  const vw = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const edgeRect = { x: vw.w - 24, y: Math.round(vw.h * 0.4), w: 20, h: Math.round(vw.h * 0.2) }
  const centreRect = { x: Math.round(vw.w / 2 - 40), y: Math.round(vw.h * 0.3), w: 80, h: 40 }
  /**
   * F2: the body's screen box, through the live camera. Generous — a square the
   * body's longest side out from its centre on every side, so a sprite drawn larger
   * than its hitbox, or turned in zero-g, is still inside it.
   */
  const K = rustConstants()
  const bodyBox = async () => {
    const p = (await dbg()).player
    const s = await toScreen(page, p.x, p.y)
    const half = Math.max(K.get('PLAYER_W'), K.get('PLAYER_H')) * s.scale
    return { x: s.x - half, y: s.y - half, w: 2 * half, h: 2 * half }
  }
  /** The subject and the control are only that if the body is in neither. */
  const bodyClear = async (lineRect, when) => {
    const body = await bodyBox()
    if (overlaps(body, centreRect)) {
      throw new Error(`${when}: the body ${JSON.stringify(body)} overlaps the centre control ${JSON.stringify(centreRect)} — the layout moved`)
    }
    if (lineRect && overlaps(body, lineRect)) {
      throw new Error(`${when}: the body ${JSON.stringify(body)} overlaps the HUD line box ${JSON.stringify(lineRect)} — the layout moved`)
    }
  }
  await bodyClear(sealed.radiation.lineRect, 'sealed photo')
  const edge0 = await samplePatch(page, edgeRect)
  const centre0 = await samplePatch(page, centreRect)
  const frame0 = await photo(page)
  await shot('radiation-sealed')

  // --- unsealed ---------------------------------------------------------------------
  await setBattery(-k.BATTERY_MAX)
  if (!(await irradiated())) throw new Error('an emptied suit in space is not irradiated by Core.irradiated')
  await waitFor(
    () => {
      const r = window.__game.debug().radiation
      return r?.state === 'irradiated' && r.edgeOpacity > 0
    },
    null,
    'the emptied suit never put the radiation feedback up',
  )
  await frames(SETTLE_FRAMES)
  const hot = await dbg()
  if (!/RADIATION/.test(hot.radiation.line ?? '')) throw new Error(`no RADIATION line: ${JSON.stringify(hot.radiation)}`)
  await bodyClear(hot.radiation.lineRect, 'irradiated photo')
  const edge1 = await samplePatch(page, edgeRect)
  const centre1 = await samplePatch(page, centreRect)
  const frame1 = await photo(page)
  await shot('radiation-irradiated')

  const r = assertChanged(edge0, edge1, {
    label: 'the radiation glow at the screen edge',
    control: { before: centre0, after: centre1 },
    minDelta: 40,
  })
  // F3: the centre, asserted untinted **on its own threshold**. `assertChanged`'s
  // control only fails at the subject's `minDelta` (40), and a 37.5 tint of the
  // centre passed it — so "the centre is never tinted" was riding on the subject.
  const still = assertUnchanged(centre0, centre1, { label: 'control: the centre, sealed → irradiated', maxDelta: 6 })
  log(`edge glow: moved ${r.delta.toFixed(1)} against the sealed frame; centre control ${still.delta.toFixed(1)}`)

  // The line: its box in the irradiated frame, compared with the same box sealed.
  const lr = hot.radiation.lineRect
  const lineBox = { x: Math.floor(lr.x), y: Math.floor(lr.y), w: Math.ceil(lr.w), h: Math.ceil(lr.h) }
  const line = await comparePhotos(page, frame0, frame1, { rect: lineBox })
  const ctl = await comparePhotos(page, frame0, frame1, { rect: centreRect })
  if (!(line.fraction > 0.1)) throw new Error(`the RADIATION line barely changed its box: ${(line.fraction * 100).toFixed(1)} %`)
  if (!(ctl.fraction < 0.02)) throw new Error(`control: the centre changed ${(ctl.fraction * 100).toFixed(1)} % too`)
  log(`HUD line: ${(line.fraction * 100).toFixed(1)} % of its box changed; centre ${(ctl.fraction * 100).toFixed(2)} %`)

  // --- resealed: a pack's worth takes it all away -----------------------------------
  await setBattery(k.BATTERY_PACK_AMOUNT)
  if (await irradiated()) throw new Error('a pack of charge did not reseal the suit')
  await waitFor(() => window.__game.debug().radiation?.state === 'sealed', null, 'the recharged suit kept the radiation feedback up')
  await frames(SETTLE_FRAMES)
  const edge2 = await samplePatch(page, edgeRect)
  const back = assertUnchanged(edge0, edge2, { label: 'the edge after resealing, against the sealed frame', maxDelta: 6 })
  if ((await dbg()).radiation.edgeOpacity !== 0) throw new Error('resealed, and the glow is still mounted')
  log(`resealed: edge back within ${back.delta.toFixed(1)} of the sealed frame`)

  // --- F8: a narrow window wraps the line instead of clipping it ------------------
  // Both lines, the long quiet one and the loud one, each inside the viewport.
  await page.setViewportSize({ width: NARROW_VIEWPORT_W, height: vw.h })
  for (const [want, delta] of [['sealed', 0], ['irradiated', -k.BATTERY_MAX]]) {
    if (delta) await setBattery(delta)
    await waitFor((s) => window.__game.debug().radiation?.state === s, want, `narrow: the suit never read ${want}`)
    await frames(SETTLE_FRAMES)
    const { radiation: rd, width } = await page.evaluate(() => ({ radiation: window.__game.debug().radiation, width: window.innerWidth }))
    const box = rd.lineRect
    if (!box || box.x < 0 || box.x + box.w > width) {
      throw new Error(`at ${width} px the ${want} line runs off screen: ${JSON.stringify(box)}`)
    }
    log(`narrow ${width} px: the ${want} line fits, ${Math.round(box.w)}×${Math.round(box.h)} px`)
  }
}
