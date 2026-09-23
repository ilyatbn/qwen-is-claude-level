// F5 — "moonlit day": the day half of F1's world. Same map, same actors, same moment
// (combatF); only the palette object P below differs. The numbers ARE the spec.
import { combatF } from './f_scene.js'

export const P_MOONLIT_DAY = {
  theme: 'dusk', timer: '2:57',
  bg: {
    skyTop: 0x16223a, skyBottom: 0x6d6a88, haze: 0x847c98, horizon: 490, grainK: 0.02, stars: 0.0012,
    glowY: 470, glowColor: 0x1e1a2c,
    moons: [
      { x: 1150, y: 118, r: 60, color: 0xd9f0e4, rays: 0.16, rayLen: 560, phase: -0.55, halo: 1.3 },   // big pale-jade moon, lit from the left
      { x: 330, y: 92, r: 24, color: 0xf2c2c8, rays: 0.035, rayLen: 300, phase: 0.6, halo: 1.0 },      // small rose moon
      { x: 640, y: 58, r: 9, color: 0xbcd4ff, rays: 0.0, rayLen: 1, phase: 0.2, halo: 0.8 },          // tiny blue moon
    ],
    layers: [
      { shape: 'pyramid', x: 960, y: 30, slope: 1.02, color: 0x6a6480, step: 5, soft: 2.8, fade: [150, 480, 0.45], jitter: 1.4 },
      { shape: 'pyramid', x: 900, y: 58, slope: 1.02, color: 0x524c66, step: 5, soft: 1.8, fade: [200, 485, 0.45], jitter: 1.1 },
      { shape: 'pyramid', x: 840, y: 90, slope: 1.02, color: 0x3a354a, step: 5, soft: 1.0, fade: [250, 490, 0.5], jitter: 0.9 },
      { shape: 'pyramid', x: 200, y: 250, slope: 1.05, color: 0x5a546c, step: 4, soft: 2.0, fade: [300, 490, 0.4], jitter: 1.0 },
    ],
  },
  // moonlight from the big moon (upper right), fuller ambient than night
  terrain: { sunDir: [0.55, 0.62, 0.45], sunCol: [0.55, 0.66, 0.72], sky: [0.13, 0.14, 0.22], ground: [0.05, 0.04, 0.05], rimCol: [0.65, 0.85, 0.85], rimK: 0.45, lipK: 0.16, lipCol: [0.6, 0.72, 0.8], interior: 0.5, bevel: 14 },
  fogBack: { color: [0.36, 0.34, 0.46], y0: 390, y1: 560, k: 0.55 },
  fogFront: { color: [0.22, 0.21, 0.3], y0: 580, y1: 720, k: 0.25, seed: 3 },
  fg: { tint: [0.01, 0.01, 0.018], spots: [{ x: -10, y: 560, r: 90, n: 9 }, { x: 1300, y: 700, r: 110, n: 10 }] },
  moon: { dx: 0.6, dy: -0.8, rgb: '205,235,225', w: 0.85, fill: '110,105,140' },
  teamA: '#e8482c', teamB: '#18c2b8', fire: '255,140,50', laser: '40,225,210', muzzle: '255,200,110', gate: '240,190,90', crystal: '110,170,255',
  gateAccent: '#f0c060', gateInner: 'rgba(60,54,76,0.9)', halo: '160,170,210',
  smoke: { rgb: '150,140,160', a: 0.16, size: 6 }, plume: 0x2a2430,
  bloom: [0.5, 0.45, 0.75], grade: { vignette: 0.45, sat: 1.05, warm: [1.04, 1.0, 0.96], cool: [0.92, 0.97, 1.1] }, exposure: 1.15,
}
export default async function () { combatF(P_MOONLIT_DAY) }
