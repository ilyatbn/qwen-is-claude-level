import { combat } from './e_scene.js'
import * as S from './e_style.js'
export default async function () {
  combat({
    bg: { skyTop: 0xf1f0ee, skyBottom: 0xe9e6e1, haze: 0xebe7e2, horizon: 490, grainK: 0.02, layers: [
      { shape: 'pyramid', x: 960, y: 30, slope: 1.02, color: 0xdcd7d1, step: 5, soft: 2.8, fade: [30, 470, 0.0], jitter: 1.4 },
      { shape: 'pyramid', x: 900, y: 58, slope: 1.02, color: 0xcac2ba, step: 5, soft: 1.8, fade: [58, 480, 0.02], jitter: 1.1 },
      { shape: 'pyramid', x: 840, y: 90, slope: 1.02, color: 0xafa398, step: 5, soft: 1.0, fade: [90, 490, 0.05], jitter: 0.9 },
      { shape: 'pyramid', x: 200, y: 250, slope: 1.05, color: 0xd6d0c9, step: 4, soft: 2.0, fade: [250, 490, 0.02], jitter: 1.0 },
    ] },
    farDecor: (g) => { for (const [x, r] of [[372, false], [384, true], [396, false]]) S.camel(g, x, 492, { s: 0.75, col: '#b3a89d', rider: r }) },
    terrain: { top: 0xc68b52, mid: 0x9b5f33, deep: 0x3a2113, haze: 0xebe7e2, rim: 0xe0b384, rimK: 0.4, yK: 0.85 },
    teamA: '#d8432a', teamB: '#139a93', tracer: '255,170,30', laser: '30,215,200', crystal: '120,180,255',
    smoke: { rgb: '92,78,66', a: 0.2, size: 6 }, plume: '38,26,18', eye: '#ff4020', gateAccent: '#e6b451', gateInner: 'rgba(246,242,236,0.95)',
    hud: { accent: '#d8432a' }, haloRGB: '240,232,222',
  })
}
