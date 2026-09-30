/**
 * The compositor (M99, T99.05): one finished trailer frame per `renderFrame(spec)`.
 *
 * `assemble.mjs` decides what plays (a source frame, its crop, dim, flash, shake — from the
 * cut); this page draws it and lays the type over it. The type is a function of `t` alone, so
 * the words land on the same beats the cuts do.
 */
import { BAR, BEAT, LINES, T } from '/timeline.mjs'

const cv = document.getElementById('c')
const ctx = cv.getContext('2d')
const W = cv.width
const H = cv.height
const FONT = 'KFN, monospace'

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

// Film grain, built once and slid about.
const grain = document.createElement('canvas')
grain.width = 512
grain.height = 512
{
  const g = grain.getContext('2d')
  const d = g.createImageData(512, 512)
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.random() * 255
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v
    d.data[i + 3] = 255
  }
  g.putImageData(d, 0, 0)
}

const cache = new Map()
async function image(url) {
  if (cache.has(url)) return cache.get(url)
  const img = new Image()
  img.src = url
  await img.decode()
  if (cache.size > 8) cache.delete(cache.keys().next().value)
  cache.set(url, img)
  return img
}

function vignette(strength) {
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, `rgba(0,0,0,${strength})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
}

/** Text with a chromatic split: red left, cyan right, then the face. */
function splitText(text, x, y, size, fill, split = 4, spacing = 0.2, align = 'center') {
  ctx.font = `${size}px ${FONT}`
  ctx.letterSpacing = `${Math.round(size * spacing)}px`
  // Canvas letter-spacing trails the last glyph too, so centred text sits half a space left.
  if (align === 'center') x += Math.round(size * spacing) / 2
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = 'rgba(255,20,40,0.75)'
  ctx.fillText(text, x - split, y)
  ctx.fillStyle = 'rgba(0,220,255,0.55)'
  ctx.fillText(text, x + split, y)
  ctx.restore()
  ctx.fillStyle = fill
  ctx.fillText(text, x, y)
}

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#%&@$/<>'
/** Letters that settle out of noise over `dur` seconds, left to right. */
function scramble(text, u, seed) {
  return [...text]
    .map((ch, i) => (ch === ' ' || u * text.length * 1.4 > i + 1 ? ch : GLYPHS[Math.floor(hash(seed + i * 7.3) * GLYPHS.length)]))
    .join('')
}

function tagline(t) {
  for (const [a, b, text] of LINES) {
    if (t < a || t >= b) continue
    const u = clamp((t - a) / 0.3)
    const s = scramble(text, u, Math.floor(t * 30))
    const y = H * 0.5
    // A red slash behind the words.
    ctx.save()
    ctx.translate(W / 2, y)
    ctx.transform(1, 0, -0.35, 1, 0, 0)
    const bw = Math.min(1, u * 2.5) * (text.length * 58 + 120)
    ctx.fillStyle = 'rgba(200,12,24,0.88)'
    ctx.fillRect(-bw / 2, -62, bw, 124)
    ctx.restore()
    const size = 92 * (1.08 - 0.08 * clamp((t - a) / 0.15))
    splitText(s, W / 2, y + 4, size, '#fff', 3, 0.14)
  }
}

function logo(t, x, y, size, alpha = 1) {
  // SHRED: brushed-metal face, a red burn behind it, sliced by the glitch now and then.
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `${size}px ${FONT}`
  ctx.letterSpacing = `${Math.round(size * 0.07)}px`
  const rx = x
  x += Math.round(size * 0.07) / 2
  ctx.lineJoin = 'round'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(255,30,30,0.9)'
  ctx.shadowBlur = size * 0.25
  ctx.fillStyle = 'rgba(120,0,0,1)'
  ctx.strokeStyle = 'rgba(120,0,0,1)'
  ctx.lineWidth = size * 0.07
  ctx.strokeText('SHRED', x, y)
  ctx.fillText('SHRED', x, y)
  ctx.shadowBlur = 0
  const g = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2)
  g.addColorStop(0, '#ffffff')
  g.addColorStop(0.45, '#d9dae2')
  g.addColorStop(0.5, '#7d7f8c')
  g.addColorStop(0.8, '#c4c6d0')
  g.addColorStop(1, '#ffffff')
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = 'rgba(255,0,40,0.6)'
  ctx.fillText('SHRED', x - size * 0.02, y)
  ctx.fillStyle = 'rgba(0,200,255,0.45)'
  ctx.fillText('SHRED', x + size * 0.02, y)
  ctx.globalCompositeOperation = 'source-over'
  // Fattened: the face stroked in its own gradient, so the thin display cut carries a title.
  ctx.strokeStyle = g
  ctx.lineWidth = size * 0.045
  ctx.strokeText('SHRED', x, y)
  ctx.fillStyle = g
  ctx.fillText('SHRED', x, y)
  ctx.lineWidth = Math.max(2, size * 0.008)
  ctx.strokeStyle = 'rgba(20,0,0,0.9)'
  ctx.strokeText('SHRED', x, y)
  // A red rule under it.
  const w = size * 3.2
  ctx.fillStyle = '#d30f1c'
  ctx.fillRect(rx - w / 2, y + size * 0.62, w, size * 0.05)
  ctx.restore()
}

/** Slice the canvas into horizontal bands and knock some sideways. */
function glitchBands(amount, seed) {
  if (amount <= 0) return
  const bands = 24
  const h = H / bands
  const snap = ctx.getImageData(0, 0, W, H)
  const tmp = new OffscreenCanvas(W, H)
  tmp.getContext('2d').putImageData(snap, 0, 0)
  for (let i = 0; i < bands; i++) {
    if (hash(seed * 3.1 + i) > amount) continue
    const dx = (hash(seed + i * 1.7) - 0.5) * 160 * amount
    ctx.drawImage(tmp, 0, i * h, W, h, dx, i * h, W, h)
  }
}

window.renderFrame = async (spec) => {
  const { t } = spec
  ctx.save()
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  const [sx, sy] = spec.shake ?? [0, 0]
  ctx.translate(sx, sy)

  if (spec.src) {
    const img = await image(spec.src)
    const z = spec.zoom ?? 1
    const cw = img.width / z
    const ch = img.height / z
    const cx = clamp((spec.cx ?? 0.5) * img.width - cw / 2, 0, img.width - cw)
    const cy = clamp((spec.cy ?? 0.5) * img.height - ch / 2, 0, img.height - ch)
    ctx.imageSmoothingQuality = 'high'
    ctx.filter = spec.game ? `contrast(1.14) saturate(1.22) brightness(${1.03 * (1 - (spec.dim ?? 0))})` : `brightness(${1 - (spec.dim ?? 0)})`
    ctx.drawImage(img, cx, cy, cw, ch, -8, -8, W + 16, H + 16)
    ctx.filter = 'none'
  }
  if (spec.game) vignette(0.5)

  tagline(t)

  // SHRED, slammed in on the title hit and pulsing on the beat through the breakdown.
  if (t >= T.title && t < T.soon) {
    const u = t - T.title
    const slam = 1 + 1.2 * Math.pow(1 - clamp(u / 0.12), 2)
    const beat = ((t - T.title) % BEAT) / BEAT
    const pulse = 1 + 0.035 * Math.exp(-beat * 6)
    logo(t, W / 2, H * 0.47, 250 * slam * pulse, clamp(u / 0.06))
  }
  // The end card: the logo back out of the noise, COMING SOON typed under it, the last hit.
  const card = T.soon + BAR * 2
  if (t >= card) {
    const u = t - card
    logo(t, W / 2, H * 0.4, 190, clamp(u / 0.2))
    const cs = T.soon + BAR * 2.5
    if (t >= cs) {
      const n = Math.min(11, Math.floor((t - cs) / (BEAT / 4)) + 1)
      const text = 'COMING SOON'.slice(0, n)
      const pad = text + ' '.repeat(11 - n)
      splitText(n < 11 ? scramble(pad, 0.7, Math.floor(t * 30)).slice(0, n) : text, W / 2, H * 0.66, 84, '#ff2b2b', 3, 0.42)
    }
  }
  const band = spec.glitch ?? 0
  glitchBands(band, Math.floor(t * 60))

  // Grain on everything, flash over everything.
  ctx.globalAlpha = spec.game ? 0.05 : 0.03
  ctx.globalCompositeOperation = 'overlay'
  ctx.drawImage(grain, -Math.floor(hash(t * 60) * 256), -Math.floor(hash(t * 60 + 1) * 256), W * 1.3, H * 1.3)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  if (spec.flash) {
    ctx.fillStyle = `rgba(255,255,255,${spec.flash})`
    ctx.fillRect(-40, -40, W + 80, H + 80)
  }
  if (spec.fade !== undefined && spec.fade < 1) {
    ctx.fillStyle = `rgba(0,0,0,${1 - spec.fade})`
    ctx.fillRect(-40, -40, W + 80, H + 80)
  }
  ctx.restore()
}

await document.fonts.load(`100px ${FONT}`)
window.ready = true
