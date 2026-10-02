#!/usr/bin/env node
/**
 * A contact sheet of a take or a clip, to look at (M99, T99.04).
 *
 *   node promo/scenes/sheet.mjs <raw take name | path to .mp4> [cols] [rows] [from s] [to s]
 *
 * Evenly spaced frames, tiled in reading order (the spacing is printed); written beside the input as
 * `<name>-sheet.jpg` (a take's sheet goes to promo/build/raw/).
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { buildDir, ffmpeg, run } from '../lib.mjs'

const [src, colsA, rowsA, fromA, toA] = process.argv.slice(2)
const cols = Number(colsA ?? 4)
const rows = Number(rowsA ?? 4)
const n = cols * rows
const isClip = src.endsWith('.mp4')
const FPS = 60
let input
let total
let out
if (isClip) {
  input = ['-i', src]
  const probe = await import('node:child_process').then(({ execFileSync }) => {
    try {
      execFileSync(ffmpeg, ['-i', src], { stdio: 'pipe' })
    } catch (e) {
      return String(e.stderr)
    }
    return ''
  })
  const m = probe.match(/Duration: (\d+):(\d+):([\d.]+)/)
  total = m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * FPS : 600
  out = src.replace(/\.mp4$/, '-sheet.jpg')
} else {
  const dir = join(buildDir, 'raw', src, 'frames')
  if (!existsSync(dir)) throw new Error(`no take ${dir}`)
  total = readdirSync(dir).filter((f) => f.endsWith('.jpg')).length
  input = ['-framerate', String(FPS), '-i', join(dir, '%06d.jpg')]
  out = join(buildDir, 'raw', `${basename(src)}-sheet.jpg`)
}
const from = Math.round(Number(fromA ?? 0) * FPS)
const to = Math.min(total, toA ? Math.round(Number(toA) * FPS) : total)
const every = Math.max(1, Math.floor((to - from) / n))
await run(ffmpeg, [
  '-y',
  ...input,
  '-vf',
  // No drawtext in ffmpeg-static: the frames read left to right, top to bottom, `every` apart.
  `select='gte(n\\,${from})*not(mod(n-${from}\\,${every}))',scale=480:-1,tile=${cols}x${rows}:padding=4`,
  '-frames:v',
  '1',
  '-q:v',
  '3',
  out,
])
console.log(`${out} (every ${(every / FPS).toFixed(2)} s from ${(from / FPS).toFixed(2)} s)`)
