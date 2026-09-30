#!/usr/bin/env node
/**
 * The trailer's score, synthesised from nothing (M99, T99.03): no samples, no licences.
 *
 *   node promo/music.mjs  ->  promo/build/music.wav
 *
 * Industrial metal at 150 BPM in drop C: double-tracked distorted guitars (a clean DI signal
 * for the whole track, then one amp and one cabinet — so palm mutes and open chords go through
 * the same distortion, which is what makes them sound like one instrument), a sub bass, a kit,
 * anvil hits, a square-wave arp, and the prequel's sound design. Everything is placed on
 * `timeline.mjs`'s clock, so the edit's cuts land on these beats.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDir } from './lib.mjs'
import { BAR, BEAT, T } from './timeline.mjs'

const SR = 44100
const N = Math.ceil((T.tail + 0.5) * SR)
const S16 = BEAT / 4 // a sixteenth

// --- small DSP kit -------------------------------------------------------------------------

let seed = 0x5eed
const rnd = () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const noise = () => rnd() * 2 - 1
const buf = () => new Float32Array(N)
const at = (sec) => Math.round(sec * SR)

/** RBJ biquad, run in place over `x` (optionally from sample a to b). */
function biquad(x, type, f, q = 0.707, gainDb = 0) {
  const w = (2 * Math.PI * f) / SR
  const cw = Math.cos(w)
  const sw = Math.sin(w)
  const al = sw / (2 * q)
  const A = Math.pow(10, gainDb / 40)
  let b0, b1, b2, a0, a1, a2
  if (type === 'lp') [b0, b1, b2, a0, a1, a2] = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al]
  else if (type === 'hp') [b0, b1, b2, a0, a1, a2] = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al]
  else if (type === 'bp') [b0, b1, b2, a0, a1, a2] = [al, 0, -al, 1 + al, -2 * cw, 1 - al]
  else if (type === 'peak')
    [b0, b1, b2, a0, a1, a2] = [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A]
  else throw new Error(type)
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y
    x[i] = y
  }
  return x
}

/** A time-varying one-pole-pair state-variable filter: `fAt(i)` gives the cutoff per sample. */
function svf(x, mode, fAt, q = 0.7) {
  let lo = 0, bd = 0
  for (let i = 0; i < x.length; i++) {
    const f = 2 * Math.sin((Math.PI * Math.min(fAt(i), SR / 6)) / SR)
    lo += f * bd
    const hi = x[i] - lo - (1 / q) * bd
    bd += f * hi
    x[i] = mode === 'lp' ? lo : mode === 'bp' ? bd : hi
  }
  return x
}

function mixInto(dst, src, start = 0, gain = 1) {
  for (let i = 0; i < src.length; i++) {
    const j = start + i
    if (j >= 0 && j < dst.length) dst[j] += src[i] * gain
  }
}

/** Band-limited saw (polyBLEP). */
function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1 }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1 }
  return 0
}

/** Freeverb-ish: 8 combs, 4 allpasses. */
function reverb(x, room = 0.84, damp = 0.3, wet = 1) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
  const aps = [556, 441, 341, 225]
  const out = new Float32Array(x.length)
  for (const len of combs) {
    const b = new Float32Array(len)
    let idx = 0, store = 0
    for (let i = 0; i < x.length; i++) {
      const y = b[idx]
      store = y * (1 - damp) + store * damp
      b[idx] = x[i] * 0.015 + store * room
      idx = (idx + 1) % len
      out[i] += y
    }
  }
  for (const len of aps) {
    const b = new Float32Array(len)
    let idx = 0
    for (let i = 0; i < out.length; i++) {
      const bo = b[idx]
      const y = -out[i] + bo
      b[idx] = out[i] + bo * 0.5
      idx = (idx + 1) % len
      out[i] = y
    }
  }
  for (let i = 0; i < out.length; i++) out[i] *= wet
  return out
}

// --- the buses -----------------------------------------------------------------------------

const diL = buf() // guitar DI, take 1 (left)
const diR = buf() // guitar DI, take 2 (right)
// The noise gate's key, per take: 1 while a note is held. Distortion turns a DI tail at -40 dB
// into a full-level smear, so the gate is what makes sixteenth chugs sixteenths.
const gates = new Map([[diL, buf()], [diR, buf()]])
const bass = buf()
const drums = buf()
const fxL = buf()
const fxR = buf()
const send = buf() // reverb send (mono)

// Drop C: C2 is the open low string.
const C2 = 65.41
const semis = (n) => C2 * Math.pow(2, n / 12)

/**
 * One guitar event into a DI take: a power chord (root, fifth, octave), two detuned saws
 * each. `mute` is a palm mute: short, and darker going into the amp.
 */
function guitar(di, t, dur, semi, { mute = false, detune = 0, lag = 0, vel = 1, power = true } = {}) {
  const f0 = semis(semi)
  const start = at(t + lag)
  const len = at(dur + (mute ? 0.03 : 0.08))
  const parts = power ? [1, 1.4983, 2] : [1]
  const out = new Float32Array(len)
  for (const p of parts) {
    for (const d of [-1, 1]) {
      const f = f0 * p * Math.pow(2, ((d * 6 + detune) / 1200))
      const dt = f / SR
      let ph = rnd()
      const amp = p === 1 ? 1 : p === 2 ? 0.55 : 0.75
      for (let i = 0; i < len; i++) {
        out[i] += (2 * ph - 1 - polyblep(ph, dt)) * amp
        ph += dt
        if (ph >= 1) ph -= 1
      }
    }
  }
  const tau = mute ? 0.055 : 1.2
  const gate = at(dur)
  for (let i = 0; i < len; i++) {
    const s = i / SR
    let e = Math.min(1, s / 0.002) * Math.exp(-s / tau)
    if (i > gate) e *= Math.exp(-(i - gate) / (0.02 * SR))
    out[i] *= e * vel
  }
  // A palm mute is darker at the pickup; the amp then brings it back up as a chug.
  biquad(out, 'lp', mute ? 700 : 3200, 0.7)
  mixInto(di, out, start)
  const g = gates.get(di)
  for (let i = start; i < start + gate && i < N; i++) g[i] = 1
}

/** The amp and cabinet: tight, two gain stages, scooped mids, rolled-off fizz. */
function amp(di) {
  const key = gates.get(di)
  biquad(di, 'hp', 110, 0.7)
  for (let i = 0; i < di.length; i++) di[i] = Math.tanh(di[i] * 9 + 0.08) - Math.tanh(0.08)
  biquad(di, 'hp', 60, 0.7)
  biquad(di, 'lp', 7000, 0.7)
  for (let i = 0; i < di.length; i++) di[i] = Math.tanh(di[i] * 5)
  biquad(di, 'peak', 130, 1.1, 2)
  biquad(di, 'peak', 650, 0.9, -7)
  biquad(di, 'peak', 2200, 1.2, 4)
  biquad(di, 'lp', 5200, 0.7)
  biquad(di, 'lp', 6500, 0.6)
  biquad(di, 'hp', 75, 0.7)
  // Gate: 1 ms open, 12 ms close.
  let g = 0
  const open = Math.exp(-1 / (0.001 * SR))
  const close = Math.exp(-1 / (0.012 * SR))
  for (let i = 0; i < di.length; i++) {
    const want = key[i]
    g = want + (g - want) * (want > g ? open : close)
    di[i] *= g
  }
  return di
}

function kick(t, vel = 1) {
  const len = at(0.35)
  const o = new Float32Array(len)
  let ph = 0
  for (let i = 0; i < len; i++) {
    const s = i / SR
    const f = 48 + 160 * Math.exp(-s / 0.025)
    ph += (2 * Math.PI * f) / SR
    o[i] = Math.sin(ph) * Math.exp(-s / 0.1) * 1.1 + noise() * Math.exp(-s / 0.002) * 0.6
  }
  for (let i = 0; i < len; i++) o[i] = Math.tanh(o[i] * 1.6)
  mixInto(drums, o, at(t), vel * 0.9)
}

function snare(t, vel = 1) {
  const len = at(0.45)
  const o = new Float32Array(len)
  const n = new Float32Array(len)
  let ph = 0
  for (let i = 0; i < len; i++) {
    const s = i / SR
    ph += (2 * Math.PI * (190 + 60 * Math.exp(-s / 0.01))) / SR
    o[i] = Math.sin(ph) * Math.exp(-s / 0.06) * 0.8
    n[i] = noise() * Math.exp(-s / 0.13)
  }
  biquad(n, 'hp', 1200, 0.7)
  biquad(n, 'peak', 4500, 1, 5)
  for (let i = 0; i < len; i++) o[i] = Math.tanh((o[i] + n[i] * 0.9) * 1.4)
  mixInto(drums, o, at(t), vel * 0.75)
  mixInto(send, o, at(t), vel * 0.5)
}

function hat(t, vel = 1, open = false) {
  const len = at(open ? 0.3 : 0.05)
  const o = new Float32Array(len)
  for (let i = 0; i < len; i++) o[i] = noise() * Math.exp(-(i / SR) / (open ? 0.1 : 0.012))
  biquad(o, 'hp', 7500, 0.7)
  mixInto(drums, o, at(t), vel * 0.22)
}

function crash(t, vel = 1, dur = 2.2) {
  const len = at(dur)
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const partials = [423, 587, 811, 1103, 1579, 2231, 3137]
  for (let i = 0; i < len; i++) {
    const s = i / SR
    const e = Math.exp(-s / (dur / 3.2)) * Math.min(1, s / 0.001)
    let m = 0
    for (const p of partials) m += Math.sin(2 * Math.PI * p * s * (1 + 0.3 * Math.sin(p * 0.001))) * 0.05
    L[i] = (noise() + m) * e
    R[i] = (noise() + m) * e
  }
  biquad(L, 'hp', 3500, 0.7)
  biquad(R, 'hp', 3500, 0.7)
  mixInto(fxL, L, at(t), vel * 0.35)
  mixInto(fxR, R, at(t), vel * 0.35)
  mixInto(send, L, at(t), vel * 0.12)
}

/** An anvil: inharmonic partials struck, the industrial half of "industrial metal". */
function anvil(t, vel = 1, pan = 0) {
  const len = at(0.9)
  const o = new Float32Array(len)
  const parts = [[523, 1], [1391, 0.6], [2287, 0.45], [3547, 0.3], [797, 0.5]]
  for (let i = 0; i < len; i++) {
    const s = i / SR
    let m = noise() * Math.exp(-s / 0.004) * 0.8
    for (const [f, a] of parts) m += Math.sin(2 * Math.PI * f * s) * a * Math.exp(-s / (0.08 + 60 / f))
    o[i] = Math.tanh(m * 1.2)
  }
  mixInto(fxL, o, at(t), vel * 0.22 * (1 - pan))
  mixInto(fxR, o, at(t), vel * 0.22 * (1 + pan))
  mixInto(send, o, at(t), vel * 0.15)
}

/** A cinematic impact: sub drop, body, noise burst — for the landing and the title. */
function impact(t, vel = 1, sub = 40) {
  const len = at(3.5)
  const o = new Float32Array(len)
  let ph = 0
  for (let i = 0; i < len; i++) {
    const s = i / SR
    ph += (2 * Math.PI * (sub + 90 * Math.exp(-s / 0.08))) / SR
    o[i] = Math.sin(ph) * Math.exp(-s / 0.9) * 1.2 + noise() * Math.exp(-s / 0.05) * 0.8
  }
  const lo = Float32Array.from(o)
  biquad(lo, 'lp', 2500, 0.7)
  for (let i = 0; i < len; i++) lo[i] = Math.tanh(lo[i] * 1.5)
  mixInto(drums, lo, at(t), vel)
  mixInto(send, lo, at(t), vel * 0.6)
}

function subBass(t, dur, semi, vel = 1) {
  const f = semis(semi)
  const len = at(dur)
  const o = new Float32Array(len)
  let ph = 0
  for (let i = 0; i < len; i++) {
    const s = i / SR
    ph += (2 * Math.PI * f) / SR
    o[i] = Math.tanh(Math.sin(ph) * 1.8) * Math.min(1, s / 0.004) * Math.min(1, (len - i) / (0.01 * SR))
  }
  mixInto(bass, o, at(t), vel * 0.4)
}

function arp(t, semi, vel = 1) {
  const f = semis(semi) * 4
  const len = at(S16 * 0.9)
  const o = new Float32Array(len)
  let ph = 0
  for (let i = 0; i < len; i++) {
    ph += f / SR
    o[i] = (ph % 1 < 0.5 ? 1 : -1) * Math.exp(-(i / SR) / 0.06)
  }
  biquad(o, 'lp', 2400, 1.5)
  mixInto(fxL, o, at(t), vel * 0.05)
  mixInto(fxR, o, at(t + 0.012), vel * 0.05)
  mixInto(send, o, at(t), vel * 0.05)
}

/** A noise sweep, `f0`→`f1` Hz over `dur`, bandpassed, with an amplitude shape. */
function sweep(t, dur, f0, f1, vel, shape = (u) => u, pan = 0) {
  const len = at(dur)
  const o = new Float32Array(len)
  for (let i = 0; i < len; i++) o[i] = noise()
  svf(o, 'bp', (i) => f0 * Math.pow(f1 / f0, i / len), 1.8)
  for (let i = 0; i < len; i++) o[i] *= shape(i / len)
  mixInto(fxL, o, at(t), vel * (1 - pan))
  mixInto(fxR, o, at(t), vel * (1 + pan))
}

// --- the prequel (0 – 14.4 s) ---------------------------------------------------------------

{
  // Drone: detuned saws on C1/C2 through a slowly opening lowpass, out by the turn.
  const len = at(T.drop - 0.45)
  const d = new Float32Array(len)
  for (const [f, a] of [[C2 / 2, 1], [C2 / 2 * 1.005, 1], [C2, 0.6], [C2 * 1.4142, 0.18]]) {
    let ph = rnd()
    for (let i = 0; i < len; i++) {
      d[i] += (2 * ph - 1) * a
      ph += f / SR
      if (ph >= 1) ph -= 1
    }
  }
  svf(d, 'lp', (i) => 90 + 380 * (i / len) ** 2 + 40 * Math.sin(i / SR), 0.9)
  biquad(d, 'hp', 45, 0.7)
  for (let i = 0; i < len; i++) {
    const s = i / SR
    d[i] *= Math.min(1, s / 2.5) * (s > T.turn ? Math.max(0, 1 - (s - T.turn) / 1.5) : 1) * 0.07
  }
  mixInto(fxL, d, 0)
  mixInto(fxR, d, 0)
  mixInto(send, d, 0, 0.3)
}
// Alien wind.
sweep(0, T.drop - 0.5, 300, 500, 0.12, (u) => Math.min(1, u * 6) * (0.6 + 0.4 * Math.sin(u * 17)) * (1 - u * 0.6), -0.3)
// The descent: engine rumble rising, then touchdown.
sweep(0.2, T.land - 0.2, 90, 420, 0.5, (u) => u * u)
impact(T.land, 0.6, 38)
crash(T.land, 0.4, 3)
// The hatch: hydraulic hiss.
sweep(T.land + 1.5, 0.9, 5000, 2500, 0.18, (u) => Math.sin(Math.PI * u))
anvil(T.land + 1.45, 0.4, 0.3)
// The breath in: bandpassed noise rising, the air being drawn in.
sweep(T.inhale, T.exhale - T.inhale - 0.3, 500, 1800, 0.5, (u) => Math.pow(u, 1.5) * (1 - Math.max(0, u - 0.9) * 10))
// The breath out, and something wrong in it.
sweep(T.exhale, 0.8, 1400, 350, 0.45, (u) => Math.sin(Math.PI * Math.min(1, u * 1.3)))
// Heartbeat, accelerating into the turn.
{
  let t = T.exhale - 0.2
  let gap = 0.75
  while (t < T.drop - 0.5) {
    impact(t, 0.25, 45)
    impact(t + 0.14, 0.15, 42)
    t += gap
    gap *= 0.72
  }
}
// Tinnitus rising, and the reverse crash that pulls into the drop.
{
  const len = at(T.drop - T.turn)
  const o = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const u = i / len
    o[i] = Math.sin((2 * Math.PI * (2800 + 900 * u) * i) / SR) * u * u * 0.05
  }
  mixInto(fxL, o, at(T.turn))
  mixInto(fxR, o, at(T.turn))
  const rl = at(1.6)
  const rc = new Float32Array(rl)
  for (let i = 0; i < rl; i++) rc[i] = noise() * Math.pow(i / rl, 3)
  biquad(rc, 'hp', 2500, 0.7)
  mixInto(fxL, rc, at(T.drop - 1.6 - 0.02), 0.5)
  mixInto(fxR, rc, at(T.drop - 1.6 - 0.02), 0.5)
}

// --- the riffs -----------------------------------------------------------------------------

/**
 * A bar as sixteen steps. 'x' palm-muted chug on the root, a digit or letter an open power
 * chord on that many semitones up from C (0-9, a=10, b=11, and 'L' is Ab below C), '-' holds
 * the last open chord, '.' is a rest. A kick doubles every note.
 */
const RIFF_A = 'X-xx0-xx6-xx7-xx'.replace('X', '0')
const RIFF_B = '0-xx3-xx2-0---xx'
const RIFF_C = '8-xx8-xxa-xxa-xx' // Ab, Bb above — the build
const RIFF_D = '0-x0x-0x3-x3x-2-'
const semiOf = (c) => (c === 'L' ? -4 : parseInt(c, 16))

function playBar(t0, pattern, { kicks = true, vel = 1 } = {}) {
  for (let s = 0; s < 16; s++) {
    const c = pattern[s]
    if (c === '-' || c === '.') continue
    let len = 1
    while (s + len < 16 && pattern[s + len] === '-') len++
    const t = t0 + s * S16
    const mute = c === 'x'
    const semi = mute ? 0 : semiOf(c)
    const dur = mute ? S16 * 0.6 : S16 * len - 0.015
    guitar(diL, t, dur, semi, { mute, detune: 3, vel })
    guitar(diR, t, dur, semi, { mute, detune: -4, lag: 0.004 + rnd() * 0.004, vel })
    subBass(t, dur, semi, mute ? 0.8 : 1)
    if (kicks) kick(t, mute ? 0.85 : 1)
  }
}

function beatKit(t0, { half = false, crashOn = false, hats = true, anvils = true, double = false } = {}) {
  if (half) snare(t0 + BEAT * 2, 1.1)
  else {
    snare(t0 + BEAT, 1)
    snare(t0 + BEAT * 3, 1)
  }
  if (double) for (let s = 0; s < 16; s++) kick(t0 + s * S16, 0.7)
  if (hats) for (let e = 0; e < 8; e++) hat(t0 + e * BEAT / 2, e % 2 ? 0.7 : 1, e === 7)
  if (crashOn) crash(t0, 1)
  if (anvils) anvil(t0 + BEAT * 3.5, 0.8, 0.4)
}

// Drop: 8 bars A/B, then 8 bars building (double bass, C and D).
for (let b = 0; b < 16; b++) {
  const t0 = T.drop + b * BAR
  const pattern = b < 8 ? (b % 2 ? RIFF_B : RIFF_A) : b < 14 ? (b % 2 ? RIFF_C : RIFF_D) : RIFF_C
  playBar(t0, pattern)
  beatKit(t0, { crashOn: b % 4 === 0, double: b >= 8, anvils: b % 2 === 1 })
  if (b >= 4) for (let s = 0; s < 16; s++) arp(t0 + s * S16, [0, 7, 12, 15, 12, 7, 3, 7][s % 8] + (b >= 8 ? 8 * (b % 2) : 0), b >= 8 ? 1.2 : 0.8)
}

// Riser: tremolo-picked C with an opening filter, a snare roll that doubles, a noise sweep.
{
  for (let s = 0; s < 32 - 2; s++) {
    const t = T.riser + s * S16
    guitar(diL, t, S16 * 0.8, 0, { mute: s < 16, detune: 3, vel: 0.6 + (s / 32) * 0.5 })
    guitar(diR, t, S16 * 0.8, 0, { mute: s < 16, detune: -4, lag: 0.005, vel: 0.6 + (s / 32) * 0.5 })
    subBass(t, S16 * 0.8, 0, 0.9)
  }
  let t = T.riser
  let step = BEAT / 2
  while (t < T.title - BEAT * 0.5) {
    snare(t, 0.4 + 0.6 * ((t - T.riser) / (T.title - T.riser)))
    t += step
    if (t > T.riser + BAR) step = BEAT / 4
    if (t > T.riser + BAR * 1.5) step = BEAT / 8
  }
  sweep(T.riser, T.title - T.riser - 0.15, 200, 9000, 0.35, (u) => u * u)
}

// SHRED: the slam, a bar of ringing chord, then a half-time breakdown.
impact(T.title, 1.4, 34)
crash(T.title, 1.3, 3)
anvil(T.title, 1.2, 0)
guitar(diL, T.title, BAR - 0.05, 0, { detune: 3 })
guitar(diR, T.title, BAR - 0.05, 0, { detune: -4, lag: 0.004 })
subBass(T.title, BAR - 0.05, 0, 1.2)
const BREAK = ['x.x..x.xx..x.0--', 'x.x..x.xx..x6---', 'x.x..x.xx..x.0--']
for (let b = 1; b < 4; b++) {
  const t0 = T.title + b * BAR
  playBar(t0, BREAK[b - 1])
  beatKit(t0, { half: true, crashOn: true, hats: false, anvils: true })
}

// COMING SOON: the main riff once more, with everything.
for (let b = 0; b < 4; b++) {
  const t0 = T.soon + b * BAR
  playBar(t0, b % 2 ? RIFF_B : RIFF_A)
  beatKit(t0, { crashOn: b % 2 === 0, double: b >= 2 })
  for (let s = 0; s < 16; s++) arp(t0 + s * S16, [0, 7, 12, 15, 12, 7, 3, 7][s % 8], 1.2)
}
// The last chord.
impact(T.end, 1.3, 34)
crash(T.end, 1.3, 3.5)
guitar(diL, T.end, 2.8, 0, { detune: 3 })
guitar(diR, T.end, 2.8, 0, { detune: -4, lag: 0.004 })
subBass(T.end, 2.5, 0, 1.2)

// --- mix and master ------------------------------------------------------------------------

amp(diL)
amp(diR)
biquad(bass, 'lp', 180, 0.7)
biquad(drums, 'hp', 30, 0.7)
const verb = reverb(send, 0.86, 0.35, 1)
const MASTER = 0.8
const L = buf()
const R = buf()
for (let i = 0; i < N; i++) {
  L[i] = (diL[i] * 0.34 + diR[i] * 0.08 + bass[i] * 0.3 + drums[i] * 0.62 + fxL[i] + verb[i] * 0.5) * MASTER
  R[i] = (diR[i] * 0.34 + diL[i] * 0.08 + bass[i] * 0.3 + drums[i] * 0.62 + fxR[i] + verb[i] * 0.5) * MASTER
}
biquad(L, 'hp', 28, 0.7)
biquad(R, 'hp', 28, 0.7)
// Bus glue, then a look-ahead limiter at -1 dBFS.
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.25) / 1.25
  R[i] = Math.tanh(R[i] * 1.25) / 1.25
}
{
  const ceil = Math.pow(10, -1 / 20)
  const look = at(0.004)
  const rel = Math.exp(-1 / (0.12 * SR))
  const peak = new Float32Array(N)
  for (let i = 0; i < N; i++) peak[i] = Math.max(Math.abs(L[i]), Math.abs(R[i]))
  let g = 1
  const lp = new Float32Array(N)
  for (let i = N - 1; i >= 0; i--) {
    // the peak `look` samples ahead, held
    let m = 0
    for (let k = 0; k <= look && i + k < N; k += 8) m = Math.max(m, peak[i + k])
    lp[i] = m
  }
  // Loudness first: bring the whole thing up, then hold the ceiling.
  const drive = 1.0
  for (let i = 0; i < N; i++) {
    const want = Math.min(1, ceil / Math.max(1e-6, lp[i] * drive))
    g = want < g ? want : want + (g - want) * rel
    L[i] *= g * drive
    R[i] *= g * drive
  }
}

const pcm = Buffer.alloc(44 + N * 4)
pcm.write('RIFF', 0)
pcm.writeUInt32LE(36 + N * 4, 4)
pcm.write('WAVEfmt ', 8)
pcm.writeUInt32LE(16, 16)
pcm.writeUInt16LE(1, 20)
pcm.writeUInt16LE(2, 22)
pcm.writeUInt32LE(SR, 24)
pcm.writeUInt32LE(SR * 4, 28)
pcm.writeUInt16LE(4, 32)
pcm.writeUInt16LE(16, 34)
pcm.write('data', 36)
pcm.writeUInt32LE(N * 4, 40)
let clipped = 0
for (let i = 0; i < N; i++) {
  for (const [c, v] of [[0, L[i]], [1, R[i]]]) {
    if (Math.abs(v) > 1) clipped++
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 4 + c * 2)
  }
}
mkdirSync(buildDir, { recursive: true })
const out = join(buildDir, 'music.wav')
writeFileSync(out, pcm)
console.log(`${out}: ${(N / SR).toFixed(1)} s, ${clipped} clipped samples`)
