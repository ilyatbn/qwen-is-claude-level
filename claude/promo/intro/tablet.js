/**
 * The researcher's holographic tablet (M99, T99.03): a glass panel whose UI is a canvas redrawn
 * for each `t`. Readings fill in one by one, each with a green check; at `T.alarm` it flips red
 * and flashes UNKNOWN SUBSTANCE DETECTED in step with the beeps the score plays.
 */
import * as THREE from 'three'
import { BEEPS, T } from './beats.js'
import { clamp, smooth } from './world.js'

export const FONT = '"Ubuntu Sans Mono", "DejaVu Sans Mono", monospace'
const CW = 1800
const CH = 1150

export const READINGS = [
  ['OXYGEN', 21.4, (v) => `${v.toFixed(1)} %`],
  ['HYDROGEN', 0.6, (v) => `${v.toFixed(1)} ppm`],
  ['CO₂', 0.04, (v) => `${v.toFixed(2)} %`],
  ['TOXINS', null, () => 'NONE DETECTED'],
]

/** 0..1: how lit the alarm is at `t` — a hard on/off following the beep pairs. */
export function alarmFlash(t) {
  if (t < T.alarm) return 0
  for (const b of BEEPS) if (t >= b && t < b + 0.11) return 1
  return 0.35
}

const canvas = document.createElement('canvas')
canvas.width = CW
canvas.height = CH
const g = canvas.getContext('2d')
const tex = new THREE.CanvasTexture(canvas)
tex.colorSpace = THREE.SRGBColorSpace
tex.anisotropy = 8
tex.generateMipmaps = true
tex.minFilter = THREE.LinearMipmapLinearFilter

/** Size in metres; the canvas maps onto it 1:1 in aspect. */
const PW = 0.56
const PH = (PW * CH) / CW
export const tablet = new THREE.Group()
const panel = new THREE.Mesh(
  new THREE.PlaneGeometry(PW, PH),
  new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
)
panel.renderOrder = 10
tablet.add(panel)
// The glass slab under the hologram: a thin, faintly reflective sheet that catches the light.
const slab = new THREE.Mesh(
  new THREE.BoxGeometry(PW * 1.04, PH * 1.06, 0.008),
  new THREE.MeshPhysicalMaterial({ color: 0x9fdcff, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.16, clearcoat: 1, depthWrite: false }),
)
slab.position.z = -0.006
tablet.add(slab)
export const tabletLight = new THREE.PointLight(0x48d8ff, 0, 1.2, 1.5)
tabletLight.position.set(0, 0, 0.18)
tablet.add(tabletLight)

function rrect(x, y, w, h, r) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}
function check(cx, cy, s, col) {
  g.strokeStyle = col
  g.lineWidth = s * 0.16
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.beginPath()
  g.arc(cx, cy, s, 0, Math.PI * 2)
  g.stroke()
  g.beginPath()
  g.moveTo(cx - s * 0.45, cy + s * 0.02)
  g.lineTo(cx - s * 0.1, cy + s * 0.38)
  g.lineTo(cx + s * 0.5, cy - s * 0.35)
  g.stroke()
}
function warn(cx, cy, s, col) {
  g.fillStyle = col
  g.beginPath()
  g.moveTo(cx, cy - s)
  g.lineTo(cx + s * 1.1, cy + s * 0.85)
  g.lineTo(cx - s * 1.1, cy + s * 0.85)
  g.closePath()
  g.fill()
  g.fillStyle = '#1a0004'
  g.fillRect(cx - s * 0.09, cy - s * 0.42, s * 0.18, s * 0.72)
  g.fillRect(cx - s * 0.09, cy + s * 0.44, s * 0.18, s * 0.18)
}

/** Redraw the UI for `t`; returns 0..1 how visible the tablet is. */
export function drawTablet(t) {
  const on = smooth(T.tablet - 0.6, T.tablet - 0.1, t)
  const red = t >= T.alarm
  const flash = alarmFlash(t)
  const cyan = '#8ff3ff'
  const ink = red ? `rgba(255, ${90 + 60 * (1 - flash)}, ${90 + 40 * (1 - flash)}, 1)` : cyan
  g.clearRect(0, 0, CW, CH)
  // Glass: a dark tint so the text holds against anything behind it, with a sheen.
  rrect(10, 10, CW - 20, CH - 20, 46)
  const bg = g.createLinearGradient(0, 0, CW, CH)
  if (red) {
    bg.addColorStop(0, `rgba(${70 + 90 * flash}, 4, 12, 0.66)`)
    bg.addColorStop(1, `rgba(${40 + 50 * flash}, 2, 8, 0.6)`)
  } else {
    bg.addColorStop(0, 'rgba(8, 40, 64, 0.62)')
    bg.addColorStop(0.55, 'rgba(4, 22, 40, 0.55)')
    bg.addColorStop(1, 'rgba(10, 46, 70, 0.6)')
  }
  g.fillStyle = bg
  g.fill()
  g.save()
  g.clip()
  const sheen = g.createLinearGradient(0, 0, CW * 0.6, CH)
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)')
  sheen.addColorStop(0.35, 'rgba(255,255,255,0.0)')
  g.fillStyle = sheen
  g.fillRect(0, 0, CW, CH)
  g.fillStyle = red ? 'rgba(255,60,60,0.05)' : 'rgba(140,240,255,0.045)'
  for (let y = 0; y < CH; y += 6) g.fillRect(0, y, CW, 2)
  g.restore()
  g.lineWidth = 7
  g.strokeStyle = ink
  g.shadowColor = ink
  g.shadowBlur = 24
  rrect(10, 10, CW - 20, CH - 20, 46)
  g.stroke()
  g.shadowBlur = 0

  // Header.
  g.fillStyle = ink
  g.textBaseline = 'middle'
  g.font = `600 64px ${FONT}`
  g.textAlign = 'left'
  g.fillText('ATMOSPHERE  ANALYSIS', 90, 120)
  g.textAlign = 'right'
  g.font = `500 46px ${FONT}`
  const pulse = Math.floor(t * 2) % 2 === 0
  g.fillText(red ? 'ALERT' : 'SAMPLE 01', CW - 150, 120)
  g.beginPath()
  g.arc(CW - 100, 120, 16, 0, Math.PI * 2)
  g.fillStyle = red ? (flash > 0.5 ? '#ff3b3b' : '#5a0e12') : pulse ? '#5dff9a' : '#1d5a3a'
  g.fill()
  g.fillStyle = ink
  g.fillRect(90, 182, CW - 180, 4)

  // Readings.
  const rowY = (i) => 290 + i * 150
  READINGS.forEach(([label, value, fmt], i) => {
    const t0 = T.reading0 + i * T.readingGap
    const y = rowY(i)
    const scanning = t < t0
    g.font = `500 70px ${FONT}`
    g.textAlign = 'left'
    g.fillStyle = scanning ? 'rgba(143,243,255,0.45)' : ink
    if (red && i === 3) g.fillStyle = ink
    g.fillText(label, 90, y)
    g.textAlign = 'right'
    if (red && i === 3) {
      g.font = `700 70px ${FONT}`
      g.fillText('??????', CW - 230, y)
      warn(CW - 140, y, 46, flash > 0.5 ? '#ff4040' : '#a01820')
      return
    }
    if (scanning) {
      // A scan bar sweeping while it waits for its turn.
      const k = (t * 1.7 + i * 0.3) % 1
      g.fillStyle = 'rgba(143,243,255,0.25)'
      g.fillRect(CW - 760, y - 6, 500, 12)
      g.fillStyle = 'rgba(143,243,255,0.7)'
      g.fillRect(CW - 760 + k * 440, y - 6, 60, 12)
      return
    }
    const u = clamp((t - t0) / 0.35)
    g.font = `600 76px ${FONT}`
    g.fillStyle = red ? 'rgba(255,170,170,0.75)' : '#eaffff'
    g.fillText(value === null ? fmt() : fmt(value * u), CW - 230, y)
    const pop = 1 + 0.35 * Math.exp(-(t - t0) * 9)
    check(CW - 140, y, 40 * pop, red ? 'rgba(255,120,120,0.5)' : '#5dff9a')
  })

  // Footer: the verdict, or the alarm.
  const fy = 900
  if (red) {
    const on2 = flash > 0.5
    rrect(70, fy - 95, CW - 140, 190, 24)
    g.fillStyle = on2 ? 'rgba(255,40,40,0.92)' : 'rgba(120,10,16,0.75)'
    g.fill()
    warn(200, fy, 62, on2 ? '#fff0e8' : '#ff5050')
    g.fillStyle = on2 ? '#fff6f0' : '#ff7070'
    g.textAlign = 'left'
    g.font = `800 92px ${FONT}`
    g.fillText('UNKNOWN SUBSTANCE', 300, fy - 2)
    g.font = `700 60px ${FONT}`
    g.textAlign = 'right'
    g.fillText('DETECTED', CW - 110, fy + 4)
  } else {
    const done = t >= T.reading0 + 3 * T.readingGap + 0.3
    g.fillStyle = done ? '#5dff9a' : 'rgba(143,243,255,0.5)'
    g.textAlign = 'left'
    g.font = `600 64px ${FONT}`
    g.fillText(done ? 'STATUS: BREATHABLE' : 'ANALYSING' + '.'.repeat(1 + (Math.floor(t * 3) % 3)), 90, fy)
    const p = clamp((t - (T.reading0 - 0.6)) / (3 * T.readingGap + 0.9))
    g.fillStyle = 'rgba(143,243,255,0.2)'
    g.fillRect(90, fy + 80, CW - 180, 14)
    g.fillStyle = done ? '#5dff9a' : cyan
    g.fillRect(90, fy + 80, (CW - 180) * p, 14)
  }
  tex.needsUpdate = true
  panel.material.opacity = on * (0.92 + 0.08 * Math.sin(t * 31) * Math.sin(t * 17))
  slab.material.opacity = 0.16 * on
  tabletLight.color.set(red ? 0xff3030 : 0x48d8ff)
  tabletLight.intensity = on * (red ? 0.08 + 0.3 * flash : 0.12)
  tablet.visible = on > 0.001
  return on
}
