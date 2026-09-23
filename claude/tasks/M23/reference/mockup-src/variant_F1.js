// F1: dusk desert, low-key. Moon behind the pyramids (god rays), effects are the key lights.
import { combatF } from './f_scene.js'
export default async function () {
  combatF({
    theme: 'dusk',
    bg: { skyTop: 0x080a12, skyBottom: 0x3a3040, haze: 0x584856, horizon: 490, grainK: 0.02, sun: { x: 1000, y: 110, r: 26, k: 1, color: 0xe8e4f0 }, rays: [1000, 110, 0.07, 480], rayColor: 0xb8b0d0, stars: 0.004, glowY: 480, glowColor: 0x2a1a18, layers: [
      { shape: 'pyramid', x: 960, y: 30, slope: 1.02, color: 0x4c4456, step: 5, soft: 2.8, fade: [150, 480, 0.5], jitter: 1.4 },
      { shape: 'pyramid', x: 900, y: 58, slope: 1.02, color: 0x373142, step: 5, soft: 1.8, fade: [200, 485, 0.5], jitter: 1.1 },
      { shape: 'pyramid', x: 840, y: 90, slope: 1.02, color: 0x25212e, step: 5, soft: 1.0, fade: [250, 490, 0.55], jitter: 0.9 },
      { shape: 'pyramid', x: 200, y: 250, slope: 1.05, color: 0x2e2936, step: 4, soft: 2.0, fade: [300, 490, 0.4], jitter: 1.0 },
    ] },
    terrain: { sunDir: [0.55, 0.62, 0.4], sunCol: [0.22, 0.26, 0.4], sky: [0.05, 0.06, 0.1], ground: [0.03, 0.02, 0.02], rimCol: [0.55, 0.62, 0.95], rimK: 0.5, lipK: 0.14, lipCol: [0.5, 0.55, 0.8], interior: 0.6, bevel: 14 },
    fogBack: { color: [0.16, 0.13, 0.17], y0: 380, y1: 560, k: 0.7 },
    fogFront: { color: [0.1, 0.09, 0.12], y0: 560, y1: 720, k: 0.35, seed: 3 },
    fg: { tint: [0.005, 0.004, 0.008], spots: [{ x: -10, y: 560, r: 90, n: 9 }, { x: 1300, y: 700, r: 110, n: 10 }] },
    moon: { dx: 0.6, dy: -0.8, rgb: '185,195,245', w: 0.75, fill: '90,80,110' },
    teamA: '#e8482c', teamB: '#18c2b8', fire: '255,140,50', laser: '40,225,210', muzzle: '255,200,110', gate: '240,190,90', crystal: '110,170,255',
    gateAccent: '#f0c060', gateInner: 'rgba(40,34,48,0.9)', halo: '140,150,200',
    smoke: { rgb: '120,110,120', a: 0.14, size: 6 }, plume: 0x1a1418,
    bloom: [0.6, 0.45, 0.7], grade: { vignette: 0.6, sat: 1.05, warm: [1.06, 1.0, 0.94], cool: [0.9, 0.95, 1.12] }, exposure: 1.1,
  })
}
