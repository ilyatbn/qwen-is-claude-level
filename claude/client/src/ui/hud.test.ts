import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BANNER_TOP,
  activated,
  TIMER_H,
  TIMER_TOP,
  bannerText,
  clockText,
  effectLabel,
  isTimerWarning,
  roundTimerText,
  type EffectRun,
} from './hud'
import { C, Core } from '../core'

// `C()` is the shipped constant table, read out of WASM. Pinning to it rather
// than to a literal 60 is §A19: a check carrying its own copy of a tunable stays
// green against a drifted implementation.
beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
})

/**
 * The DOM half is asserted on **rendered pixels** in
 * `scripts/checks/hud-timer.mjs` (§C2) — a colour set on a style object is not a
 * red timer. What is here is the arithmetic those pixels are produced from.
 */
describe('clockText', () => {
  it('floors to whole seconds and pads', () => {
    expect(clockText(0)).toBe('0:00')
    expect(clockText(9.9)).toBe('0:09')
    expect(clockText(60)).toBe('1:00')
    expect(clockText(61.4)).toBe('1:01')
    expect(clockText(240)).toBe('4:00')
  })

  it('never renders a negative clock', () => {
    // The deadline is the server's and the local frame can run past it.
    expect(clockText(-3)).toBe('0:00')
  })
})

describe('roundTimerText', () => {
  it('is blank in the lobby, where no round timer exists (docs/74 §E1)', () => {
    // The lobby's `time_left` reaches the client as 0, which is what drew `0:00`.
    expect(roundTimerText('lobby', 0)).toBe('')
  })

  it('counts in every phase a match has', () => {
    // The control: a function that returned '' everywhere would pass the test above.
    expect(roundTimerText('warmup', 9.5)).toBe('0:09')
    expect(roundTimerText('playing', 125)).toBe('2:05')
    expect(roundTimerText('ended', 20)).toBe('0:20')
  })
})

describe('isTimerWarning', () => {
  /**
   * Both sides of the boundary, because a threshold test that only checks the
   * far side passes for `>= 0`.
   */
  it('is on below the threshold and off at it', () => {
    const warn = C().TIMER_WARN_SECONDS
    expect(isTimerWarning(warn - 0.01, warn)).toBe(true)
    expect(isTimerWarning(warn, warn)).toBe(false)
    expect(isTimerWarning(warn + 1, warn)).toBe(false)
  })

  it('pins to the shipped constant, not to 60', () => {
    // §A19: a check carrying its own copy of a tunable stays green against a
    // drifted implementation. If `TIMER_WARN_SECONDS` moves, this moves with it.
    const warn = C().TIMER_WARN_SECONDS
    expect(warn).toBeGreaterThan(0)
    expect(isTimerWarning(warn / 2, warn)).toBe(true)
    expect(isTimerWarning(warn * 2, warn)).toBe(false)
  })
})

describe('effectLabel', () => {
  it('turns a Rust type name into words', () => {
    expect(effectLabel('ToxicRain')).toBe('Toxic Rain')
    expect(effectLabel('MeteorShower')).toBe('Meteor Shower')
    expect(effectLabel('LavaBurst')).toBe('Lava Burst')
    expect(effectLabel('HeavyFog')).toBe('Heavy Fog')
  })

  it('leaves a single word and an empty string alone', () => {
    expect(effectLabel('Fog')).toBe('Fog')
    expect(effectLabel('')).toBe('')
  })
})

describe('bannerText', () => {
  const run = (over: Partial<EffectRun> = {}): EffectRun => ({
    id: 1,
    kind: 'ToxicRain',
    phase: 'active',
    endsAt: 40,
    ...over,
  })

  /** The control for every assertion below: with nothing running, no banner. */
  it('is absent with no effect running', () => {
    expect(bannerText([], 10)).toBeNull()
  })

  it('names the effect and counts it down', () => {
    expect(bannerText([run({ endsAt: 40 })], 10)).toBe('Toxic Rain 0:30')
    expect(bannerText([run({ endsAt: 40 })], 25)).toBe('Toxic Rain 0:15')
  })

  /** §C8: the telegraph is the warning, so it is on screen during it. */
  it('shows the telegraph, marked as incoming', () => {
    expect(bannerText([run({ phase: 'telegraph', endsAt: 20 })], 8)).toBe(
      'INCOMING · Toxic Rain 0:12',
    )
  })

  it('clears once the effect has ended', () => {
    expect(bannerText([run({ phase: 'end' })], 10)).toBeNull()
    // ...and also when the deadline has simply passed, so a dropped `effect_end`
    // does not leave a banner up for the rest of the round.
    expect(bannerText([run({ endsAt: 9 })], 10)).toBeNull()
  })

  /** T22.08D F5: a flare's last seconds have no ribbon, and the banner says so. */
  it('says a flare is burning out once its ribbon has gone', () => {
    const flare = run({ kind: 'SolarFlare', endsAt: 40 })
    // The control: lit, it reads like any other effect.
    expect(bannerText([flare], 37)).toBe('Solar Flare 0:03')
    expect(bannerText([{ ...flare, tail: true }], 37)).toBe('BURNING OUT · Solar Flare 0:03')
  })

  /**
   * T22.14C: a shower's `Active` runs `METEOR_DURATION + METEOR_FALL_TIME` (T22.14A H3)
   * but meteors drop only in the first `METEOR_DURATION`. The banner counts the
   * dropping window, then says the sky is clearing until the effect ends — the
   * flare's "burning out" for the shower.
   */
  it('counts a shower’s dropping window, then says it is clearing', () => {
    const shower = run({ kind: 'MeteorShower', endsAt: 40, dropsUntil: 24 })
    expect(bannerText([shower], 14)).toBe('Meteor Shower 0:10')
    expect(bannerText([shower], 30)).toBe('CLEARING · Meteor Shower 0:10')
    // The control: an effect with no dropping window counts to its end throughout.
    expect(bannerText([run({ endsAt: 40 })], 14)).toBe('Toxic Rain 0:26')
  })

  /**
   * And both deadlines come from the effect's own schedule, anchored where the
   * server anchors them — `Active` starts when the telegraph ends (`effect_phase`)
   * and lasts `duration` (`effect_start`'s, the active window alone). The run
   * started at the telegraph ended `EFFECT_TELEGRAPH` early before T22.14C.
   */
  it('anchors the end and the dropping window on the activation', () => {
    const started: EffectRun = { id: 3, kind: 'MeteorShower', phase: 'telegraph', endsAt: 0 + 26, duration: 26 }
    const on = activated(started, 3, 10)
    expect(on.phase).toBe('active')
    expect(on.endsAt).toBe(3 + 26)
    expect(on.dropsUntil).toBe(3 + 10)
    // No dropping window: none is set.
    expect(activated({ ...started, kind: 'ToxicRain' }, 3, null).dropsUntil).toBeUndefined()
  })

  /** `docs/13` §1 allows overlap; the banner has one line. */
  it('names the effect ending soonest when two overlap', () => {
    const both = [
      run({ id: 1, kind: 'HeavyFog', endsAt: 90 }),
      run({ id: 2, kind: 'MeteorShower', endsAt: 45 }),
    ]
    expect(bannerText(both, 30)).toBe('Meteor Shower 0:15')
    // ...and falls back to the other one once that has gone, rather than to
    // nothing — the second effect is still running.
    expect(bannerText(both, 50)).toBe('Heavy Fog 0:40')
  })
})

/**
 * The 2026-09-16 layout move, asserted as an **ordering** rather than as the
 * numbers themselves.
 *
 * Pinning `BANNER_TOP === 56` would pass the day someone shrinks the timer and
 * leaves a 20 px hole, and fail the day someone adds a pixel of padding for a
 * good reason. What the owner asked for is *"notifications of incoming hazards
 * shoud be below it"*, and that is a relation between two boxes.
 */
describe('the top-centre HUD stack', () => {
  it('puts the hazard banner clear of the bottom of the timer', () => {
    expect(BANNER_TOP).toBeGreaterThanOrEqual(TIMER_TOP + TIMER_H)
  })
})
