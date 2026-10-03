#!/usr/bin/env node
/**
 * The intro's sound (M99, T99.03): sound design synthesised from nothing, over the owner's own
 * track (`../music/ingame1.mp3`, decoded to build/ — never committed) as a quiet bed.
 *
 *   node promo/intro-sound.mjs  ->  promo/build/intro.wav  (+ intro-sfx.wav, intro-bed.wav stems)
 *
 * Owner, 2026-10-02: kept: the landing, the tablet (readings + alarm), the helmet seals, the breath, the heartbeats
 * and the final hit. Cut: footsteps, the door and ramp, the drone/wind, the calm chord, the twitch riser and crackles,
 * the ringing tone. Music +10 %.
 *
 * Every sound is placed on `intro/beats.js`'s clock — the same numbers the picture reads — so the
 * alarm beeps on the frames the tablet flashes and the ramp clunks on the frame it lands.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { biquad, mixInto, readWav, reverb, SR, svf, writeWav } from './dsp.mjs'
import { buildDir, ffmpeg, root, run } from './lib.mjs'
import { BEEPS, CREW, RAMP, T } from './intro/beats.js'

const N = Math.ceil((T.end + 0.6) * SR)
const at = (s) => Math.round(s * SR)
let seed = 0x1a7e
const rnd = () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const noise = () => rnd() * 2 - 1
const buf = (len = N) => new Float32Array(len)

const L = buf()
const R = buf()
const send = buf()
/** Mix `o` in at `t`, panned (-1 left .. 1 right), with a reverb send. */
function put(o, t, vel = 1, pan = 0, wet = 0.15) {
  mixInto(L, o, at(t), vel * Math.min(1, 1 - pan))
  mixInto(R, o, at(t), vel * Math.min(1, 1 + pan))
  mixInto(send, o, at(t), vel * wet)
}
function shaped(len, fill, env) {
  const o = buf(len)
  for (let i = 0; i < len; i++) o[i] = fill(i, i / SR) * env(i / len, i / SR)
  return o
}

// --- instruments ---------------------------------------------------------------------------
function sweep(t, dur, f0, f1, vel, shape = (u) => u, pan = 0, q = 1.8) {
  const len = at(dur)
  const o = shaped(len, () => noise(), () => 1)
  svf(o, 'bp', (i) => f0 * Math.pow(f1 / f0, i / len), q)
  for (let i = 0; i < len; i++) o[i] *= shape(i / len)
  put(o, t, vel, pan)
}
function impact(t, vel = 1, sub = 40, len = 3.0) {
  let ph = 0
  const o = shaped(at(len), (i, s) => {
    ph += (2 * Math.PI * (sub + 90 * Math.exp(-s / 0.08))) / SR
    return Math.sin(ph) * Math.exp(-s / 0.9) * 1.2 + noise() * Math.exp(-s / 0.05) * 0.8
  }, () => 1)
  biquad(o, 'lp', 2500, 0.7)
  for (let i = 0; i < o.length; i++) o[i] = Math.tanh(o[i] * 1.5)
  put(o, t, vel, 0, 0.5)
}
/** A heavy metal clunk: a low thud and a short inharmonic ring. */
function clank(t, vel = 1, pan = 0) {
  const parts = [[180, 1], [431, 0.6], [977, 0.35], [1663, 0.2]]
  let ph = 0
  const o = shaped(at(0.9), (i, s) => {
    ph += (2 * Math.PI * (70 + 60 * Math.exp(-s / 0.03))) / SR
    let m = Math.sin(ph) * Math.exp(-s / 0.12) * 1.4 + noise() * Math.exp(-s / 0.006) * 0.7
    for (const [f, a] of parts) m += Math.sin(2 * Math.PI * f * s) * a * Math.exp(-s / (0.05 + 30 / f))
    return Math.tanh(m)
  }, () => 1)
  put(o, t, vel * 0.8, pan, 0.3)
}
/** A hydraulic ram: a motor whine gliding up and a hiss, for `dur` seconds. */
function hydraulic(t, dur, vel = 1, f0 = 110, f1 = 160) {
  let ph = 0
  const o = shaped(at(dur), (i, s) => {
    const u = s / dur
    ph += (2 * Math.PI * (f0 + (f1 - f0) * u)) / SR
    return (Math.sin(ph) + 0.4 * Math.sin(ph * 2.01) + 0.25 * Math.sign(Math.sin(ph * 3))) * 0.5 + noise() * 0.35
  }, (u) => Math.min(1, u * 12) * Math.min(1, (1 - u) * 10))
  biquad(o, 'lp', 2200, 0.8)
  put(o, t, vel * 0.32, 0.1, 0.1)
}
function step(t, metal, vel = 1, pan = 0) {
  const o = shaped(at(metal ? 0.18 : 0.09), (i, s) => {
    let m = noise() * Math.exp(-s / (metal ? 0.012 : 0.02))
    if (metal) m += (Math.sin(2 * Math.PI * 820 * s) * 0.5 + Math.sin(2 * Math.PI * 1460 * s) * 0.3) * Math.exp(-s / 0.05)
    return m
  }, () => 1)
  if (!metal) biquad(o, 'lp', 900, 0.7)
  else biquad(o, 'bp', 1200, 0.9)
  put(o, t, vel * (metal ? 0.7 : 0.8), pan, 0.08)
}
function chirp(t, f0, f1, dur, vel = 1, pan = 0) {
  let ph = 0
  const o = shaped(at(dur), (i, s) => {
    ph += (2 * Math.PI * (f0 + (f1 - f0) * Math.min(1, s / (dur * 0.6)))) / SR
    return Math.sin(ph) + 0.15 * Math.sin(ph * 2)
  }, (u, s) => Math.min(1, s / 0.004) * Math.exp(-u * 3.5))
  put(o, t, vel * 0.3, pan, 0.25)
}
/** The alarm: a hard square, band-limited enough not to fizz. */
/**
 * The alarm (owner, 2026-10-03: "too loud and too annoying … a single beep type, softer like promo/alert.mp3 but
 * faster"). Measured off alert.mp3: partials 710 / 1650 / 2370 / 4020 Hz at 1 / .36 / .22 / .16, a ~20 ms rise and a
 * flat hold — shorter here (`dur`), so it can repeat faster.
 */
const ALERT_PARTIALS = [[710, 1], [1650, 0.36], [2370, 0.22], [4020, 0.16]]
function beep(t, dur = 0.18, vel = 1) {
  const norm = ALERT_PARTIALS.reduce((m, [, a]) => m + a, 0)
  const o = shaped(at(dur), (i, s) => ALERT_PARTIALS.reduce((m, [f, a]) => m + Math.sin(2 * Math.PI * f * s) * a, 0) / norm,
    (u, s) => Math.min(1, s / 0.02) * Math.min(1, (1 - u) * dur / 0.03))
  put(o, t, vel * 0.07, 0, 0.1)
}
/** A helmet seal letting go: a click, then a hiss of pressure. */
function seal(t, vel = 1, pan = 0) {
  const o = shaped(at(0.7), (i, s) => noise() * (s < 0.004 ? 2 : 1), (u, s) => (s < 0.004 ? 1 : 0.6 * Math.exp(-s / 0.18)))
  biquad(o, 'hp', 2400, 0.7)
  put(o, t, vel * 0.5, pan, 0.1)
}
function heartbeat(t, vel = 1) {
  for (const [dt, v] of [[0, 1], [0.15, 0.65]]) {
    let ph = 0
    const o = shaped(at(0.3), (i, s) => {
      ph += (2 * Math.PI * (48 + 30 * Math.exp(-s / 0.02))) / SR
      return Math.sin(ph)
    }, (u, s) => Math.min(1, s / 0.005) * Math.exp(-s / 0.07))
    put(o, t + dt, vel * v * 0.9, 0, 0.05)
  }
}

// --- the sound design ----------------------------------------------------------------------

// The descent and touchdown.
/** Owner, 2026-10-03: the landing and the breath 10 % quieter. */
const QUIETER = 0.9
sweep(0.2, T.land - 0.2, 80, 420, 0.42 * QUIETER, (u) => u * u)
impact(T.land, 0.9 * QUIETER, 38)
sweep(T.land, 1.6, 3000, 600, 0.12 * QUIETER, (u) => Math.exp(-u * 4)) // debris

// The tablet: it wakes, each reading chirps as it lands, a two-note all-clear.
chirp(T.tablet - 0.55, 600, 1800, 0.25, 0.8)
const notes = [1047, 1319, 1568, 2093]
notes.forEach((f, i) => chirp(T.reading0 + i * T.readingGap, f, f, 0.16, 1))
const clear = T.reading0 + 3 * T.readingGap + 0.3
chirp(clear, 1568, 1568, 0.12, 0.9)
chirp(clear + 0.13, 2093, 2093, 0.3, 0.9)

// His helmet's seal, then the breath (the calm chord went).
seal(T.breath + 0.45, 1, 0.1)
// The breath in, held, and out (owner kept it).
sweep(T.inhale, T.hold - T.inhale, 420, 1400, 0.95 * QUIETER, (u) => Math.pow(u, 0.7) * Math.min(1, (1 - u) * 14), 0, 1.1)
sweep(T.inhale, T.hold - T.inhale, 2200, 3600, 0.25 * QUIETER, (u) => u * Math.min(1, (1 - u) * 14), 0, 2)
sweep(T.exhale, 1.3, 1200, 380, 0.85 * QUIETER, (u) => Math.sin(Math.PI * Math.min(1, u * 1.15)) * (1 - u * 0.3), 0, 1.1)
// The others' seals.
seal(T.helmets + 0.5, 0.9, 0.4)
seal(T.helmets + 0.9, 0.9, -0.4)
seal(T.helmets + 1.2, 0.8, -0.1)

// The alarm: on the beeps the tablet flashes on.
BEEPS.forEach((b) => beep(b, 0.18, b < T.turn ? 1 : 0.6))

// The heart speeding up under the twitching (the riser and glitch crackles went).
{
  let t = T.twitch
  let gap = 0.7
  while (t < T.black - 0.1) {
    heartbeat(t, 0.7 + 0.3 * (t - T.twitch) / (T.black - T.twitch))
    t += gap
    gap = Math.max(0.28, gap * 0.85)
  }
}
// The turn: a reverse swell into the hit, then a slow heartbeat under ringing ears.
{
  const len = at(T.black - T.turn)
  const o = shaped(len, () => noise(), (u) => u ** 3)
  biquad(o, 'hp', 1800, 0.7)
  put(o, T.turn, 0.35, 0, 0.3)
}
impact(T.black, 1.25, 33, 3.5)
for (let t = T.black + 0.9; t < T.end - 0.5; t += 0.95) heartbeat(t, 0.8)

// --- the bed: the owner's track ------------------------------------------------------------
/** Where in the track the intro starts (s): its quiet opening under the landing; the band
 *  comes in at ~0:16, under the tablet's all-clear and the breath. */
export const BED_FROM = 0
/** The bed's level: dB of gain on the track as mastered (I −15.5 LUFS) — measured, see task. */
/** Owner, 2026-10-02: "up the music level 10%" — ×1.1 in amplitude on the earlier −8 dB. */
const BED_DB = -8 + 20 * Math.log10(1.1)
/** Owner, 2026-10-02: "the final 3 seconds the music should ramp up to max" — the last seconds swell to the track
 *  at full level (0 dB, as mastered), easing in by dB, with only a click-guard fade at the cut. */
const BED_SWELL = 3
const CUT_FADE = 0.12
const BED_HOLD = 0.5
/** Ducks under the big moments: [from, to, dB]. */
const DUCKS = [
  [T.land - 0.1, T.land + 1.4, -7],
  [T.inhale, T.exhale + 1.4, -4],
  [T.alarm, T.turn, -4],
  [T.turn, T.end - BED_SWELL, -9],
]
const bedL = buf()
const bedR = buf()
{
  const track = join(buildDir, 'ingame1.wav')
  if (!existsSync(track)) {
    mkdirSync(buildDir, { recursive: true })
    await run(ffmpeg, ['-y', '-i', join(root, '..', 'music', 'ingame1.mp3'), '-ac', '2', '-ar', String(SR), track])
  }
  const [mL, mR] = readWav(track)
  const off = at(BED_FROM)
  const g0 = Math.pow(10, BED_DB / 20)
  let duck = 1
  const k = Math.exp(-1 / (0.12 * SR))
  for (let i = 0; i < N; i++) {
    const s = i / SR
    let want = 1
    for (const [a, b, db] of DUCKS) if (s >= a && s < b) want = Math.min(want, Math.pow(10, db / 20))
    duck = want + (duck - want) * k
    // No fade-in (owner, 2026-10-03): the track starts at its level on frame one.
    const fade = Math.max(0, Math.min(1, (T.end - s) / CUT_FADE))
    // Reaches 0 dB `BED_HOLD` before the cut and holds there: linear in dB from where the bed sits.
    const swell = Math.max(0, Math.min(1, (s - (T.end - BED_SWELL)) / (BED_SWELL - BED_HOLD)))
    const g = swell > 0 ? Math.pow(10, ((BED_DB + 20 * Math.log10(duck)) * (1 - swell)) / 20) * fade : g0 * duck * fade
    bedL[i] = (mL[off + i] ?? 0) * g
    bedR[i] = (mR[off + i] ?? 0) * g
  }
}

// --- mix and master ------------------------------------------------------------------------
const verb = reverb(send, 0.84, 0.35, 1)
for (let i = 0; i < N; i++) {
  L[i] += verb[i] * 0.6
  R[i] += verb[i] * 0.6
}
biquad(L, 'hp', 25, 0.7)
biquad(R, 'hp', 25, 0.7)
const ML = buf()
const MR = buf()
for (let i = 0; i < N; i++) {
  ML[i] = L[i] + bedL[i]
  MR[i] = R[i] + bedR[i]
}
// A look-ahead limiter at -1 dBFS.
{
  const ceil = Math.pow(10, -1 / 20)
  const look = at(0.004)
  const rel = Math.exp(-1 / (0.15 * SR))
  let g = 1
  const peak = new Float32Array(N)
  for (let i = N - 1; i >= 0; i--) {
    let m = 0
    for (let k = 0; k <= look && i + k < N; k += 4) m = Math.max(m, Math.abs(ML[i + k]), Math.abs(MR[i + k]))
    peak[i] = m
  }
  for (let i = 0; i < N; i++) {
    const want = Math.min(1, ceil / Math.max(1e-6, peak[i]))
    g = want < g ? want : want + (g - want) * rel
    ML[i] *= g
    MR[i] *= g
  }
}
mkdirSync(buildDir, { recursive: true })
writeWav(join(buildDir, 'intro-sfx.wav'), L, R)
writeWav(join(buildDir, 'intro-bed.wav'), bedL, bedR)
const out = join(buildDir, 'intro.wav')
const clipped = writeWav(out, ML, MR)
console.log(`${out}: ${(N / SR).toFixed(1)} s, ${clipped} clipped samples`)
