/**
 * T9.01 — audio.
 *
 * The hard part of testing sound headlessly is that **everything passes if you
 * assert on intent**. Chromium without an audio device still runs every line of
 * the mixer, still resolves every promise, still returns from `play()`. So this
 * check asserts on effects at each layer instead:
 *
 *  - the samples actually decoded (a count of `AudioBuffer`s, not of fetches);
 *  - the context actually reached `running` after a gesture;
 *  - a cue actually started a voice **with a gain above zero** — the mixer
 *    returns the applied gain precisely so this is observable;
 *  - and the negative: at master volume 0, nothing starts at all.
 *
 * The last one is the control. Without it, "sounds played" is satisfied by a
 * build that plays sounds unconditionally, including ones that should have been
 * silent (§A26 — a test asserting a presence needs its opposite).
 */
export default async function ({ page, shot, log }) {
  const audio = () => page.evaluate(() => window.__game.audio())
  const clear = () => page.evaluate(() => window.__game.clearCues())

  // Decoding happens at boot and is not awaited by the scene, so give it a
  // moment rather than racing it.
  await page.waitForTimeout(1200)

  let a = await audio()
  log(`samples decoded: ${a.samples}`)
  if (a.samples === 0) {
    throw new Error(
      'no samples decoded — assets/audio/*.ogg missing? run scripts/build-audio.mjs',
    )
  }
  if (a.samples < 20) {
    throw new Error(`only ${a.samples} samples decoded; audio.json names 23`)
  }

  // Browsers refuse to start an AudioContext without a user gesture. A click is
  // the gesture; if this stops working the game is silent for every real player
  // and every readout below would still look healthy.
  await page.mouse.move(640, 400)
  await page.keyboard.press('Shift')
  await page.waitForTimeout(300)
  a = await audio()
  log(`context unlocked: ${a.unlocked}`)
  if (!a.unlocked) throw new Error('the AudioContext never reached "running" after a gesture')

  // --- a cue must start a real voice -----------------------------------------
  await clear()
  await page.evaluate(() => window.__game.place(700, 300))
  await page.waitForTimeout(150)
  await page.keyboard.down('d')
  await page.waitForTimeout(1400)
  await page.keyboard.up('d')
  await page.waitForTimeout(200)

  a = await audio()
  log(`cues after walking: ${a.cues.join(', ') || '(none)'}`)
  if (!a.cues.includes('walk')) {
    throw new Error('walking produced no footstep cue with an audible gain')
  }

  // --- firing, which is the loudest thing in the game ------------------------
  await clear()
  await page.evaluate(() => window.__game.fire())
  await page.waitForTimeout(900)
  a = await audio()
  log(`cues after firing: ${a.cues.join(', ') || '(none)'}`)
  if (!a.cues.some((c) => c.startsWith('fire_') || c === 'explode')) {
    throw new Error('firing produced neither a shot nor an explosion cue')
  }

  // --- the control: silence must actually be silent --------------------------
  await page.evaluate(() => window.__game.setMasterVolume(0))
  await clear()
  await page.keyboard.down('d')
  await page.waitForTimeout(1200)
  await page.keyboard.up('d')
  await page.evaluate(() => window.__game.fire())
  await page.waitForTimeout(600)
  const silent = await audio()
  log(`cues at master volume 0: ${silent.cues.length}`)
  if (silent.cues.length !== 0) {
    throw new Error(
      `master volume 0 still started ${silent.cues.length} voice(s): ${silent.cues.join(', ')}`,
    )
  }
  await page.evaluate(() => window.__game.setMasterVolume(1))

  await shot('audio')
  log('samples decode, the context unlocks, cues start real voices, and zero means zero')
}
