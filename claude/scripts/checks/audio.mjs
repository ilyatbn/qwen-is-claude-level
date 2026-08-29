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
  // **Walking is this assertion's precondition, not its subject.**
  //
  // This used to teleport to a hardcoded (700, 300) and hold `d`. After §E12
  // made rocks and bushes 50 % bigger that spot stopped being above walkable
  // floor: the player fell for the whole hold and the cue list read
  // `land, land` — a fixture reporting "no footstep" about a player that was
  // never walking. The subject is whether a cue starts an audible voice; where
  // the ground is is something this check has to establish, not assume.
  //
  // Teleporting somewhere better was tried and is worse. Placing on a scanned
  // flat run left the body wedged — grounded, and `dx = 0.0` holding **either**
  // direction, measured — because a position that satisfies a mask scan is not
  // the same as one the physics will accept. So this walks from where the
  // player already is, in whichever direction has room, which is what
  // `debug-mode` does on this same terrain and why that check still passes.
  const roomFor = async (dir) =>
    page.evaluate(
      ([d, halfW, h, reach]) => {
        const core = window.__game.core
        const p = window.__game.debug().player
        for (let step = 8; step <= reach; step += 8) {
          const x = Math.round(p.x + d * (halfW + step))
          // Torso and head only: the feet may meet a step up, which is a slope
          // the body walks, not a wall.
          for (const dy of [-h * 0.4, -h * 0.1, h * 0.2]) {
            if (core.solidAt(x, Math.round(p.y + dy))) return step
          }
        }
        return reach
      },
      [dir, k.PLAYER_W / 2, k.PLAYER_H, Math.round(k.WALK_SPEED * 0.7)],
    )

  const k = await page.evaluate(() => window.__game.constants())
  // Release anything held and let the body settle. `standStill` in the harness
  // does exactly this, but this check is a module with no harness import, and
  // pulling one in for four lines would be the larger change.
  for (const key of ['a', 'd', 'w', 's']) await page.keyboard.up(key).catch(() => {})
  const grounded = await page
    .waitForFunction(() => window.__game.debug().player?.grounded === true, null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  if (!grounded) {
    throw new Error('the player never reached the ground, so there is no walk to hear')
  }
  const roomRight = await roomFor(1)
  const roomLeft = await roomFor(-1)
  const key = roomRight >= roomLeft ? 'd' : 'a'
  const room = Math.max(roomRight, roomLeft)
  // D-29: say which situation was unavailable rather than measuring a worse one.
  // A footstep needs the body moving, and a player in a slot with walls both
  // sides is a fixture with nowhere to walk, not a silent audio fault.
  if (room < k.PLAYER_W) {
    throw new Error(
      `nowhere to walk: ${roomRight} px right, ${roomLeft} px left, against a ` +
        `${k.PLAYER_W} px body — no step can be taken here`,
    )
  }

  await clear()
  const p0 = await page.evaluate(() => window.__game.debug().player)
  await page.keyboard.down(key)
  await page.waitForTimeout(1400)
  const p1 = await page.evaluate(() => window.__game.debug().player)
  await page.keyboard.up(key)
  await page.waitForTimeout(200)

  // The precondition, asserted rather than assumed. Without this, "no walk cue"
  // is ambiguous between a broken mixer and a player that never moved — which
  // is exactly the ambiguity that made this check report an audio fault about
  // terrain.
  const moved = Math.abs(p1.x - p0.x)
  if (moved < 1) {
    throw new Error(
      `held "${key}" for 1.4 s with ${room} px of room and moved ${moved.toFixed(1)} px — ` +
        'the player never walked, so this says nothing about the footstep cue',
    )
  }

  a = await audio()
  log(`walked ${moved.toFixed(0)} px holding "${key}"; cues: ${a.cues.join(', ') || '(none)'}`)
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
