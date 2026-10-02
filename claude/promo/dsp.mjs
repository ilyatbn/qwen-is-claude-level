/**
 * The trailer's small DSP kit (M99), shared by the gameplay score (`music.mjs`) and the intro's
 * sound (`intro-sound.mjs`). Plain functions over Float32Arrays at 44.1 kHz; nothing random.
 */
import { readFileSync, writeFileSync } from 'node:fs'

export const SR = 44100

/** RBJ biquad, run in place over `x` (optionally from sample a to b). */
export function biquad(x, type, f, q = 0.707, gainDb = 0) {
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
export function svf(x, mode, fAt, q = 0.7) {
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

export function mixInto(dst, src, start = 0, gain = 1) {
  for (let i = 0; i < src.length; i++) {
    const j = start + i
    if (j >= 0 && j < dst.length) dst[j] += src[i] * gain
  }
}

/** Band-limited saw (polyBLEP). */
export function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1 }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1 }
  return 0
}

/** Freeverb-ish: 8 combs, 4 allpasses. */
export function reverb(x, room = 0.84, damp = 0.3, wet = 1) {
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

/** Write a stereo 16-bit WAV; returns how many samples were clipped. */
export function writeWav(path, L, R) {
  const n = L.length
  const pcm = Buffer.alloc(44 + n * 4)
  pcm.write('RIFF', 0)
  pcm.writeUInt32LE(36 + n * 4, 4)
  pcm.write('WAVEfmt ', 8)
  pcm.writeUInt32LE(16, 16)
  pcm.writeUInt16LE(1, 20)
  pcm.writeUInt16LE(2, 22)
  pcm.writeUInt32LE(SR, 24)
  pcm.writeUInt32LE(SR * 4, 28)
  pcm.writeUInt16LE(4, 32)
  pcm.writeUInt16LE(16, 34)
  pcm.write('data', 36)
  pcm.writeUInt32LE(n * 4, 40)
  let clipped = 0
  for (let i = 0; i < n; i++) {
    for (const [c, v] of [[0, L[i]], [1, R[i]]]) {
      if (Math.abs(v) > 1) clipped++
      pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 4 + c * 2)
    }
  }
  writeFileSync(path, pcm)
  return clipped
}

/** Read a 16-bit PCM stereo WAV at SR (as ffmpeg writes it) into [L, R]. */
export function readWav(path) {
  const b = readFileSync(path)
  let p = 12
  while (b.toString('ascii', p, p + 4) !== 'data') p += 8 + b.readUInt32LE(p + 4)
  const len = b.readUInt32LE(p + 4) / 4
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    L[i] = b.readInt16LE(p + 8 + i * 4) / 32768
    R[i] = b.readInt16LE(p + 8 + i * 4 + 2) / 32768
  }
  return [L, R]
}
