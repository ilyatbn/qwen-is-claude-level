// E2: same system, cold dusk palette + ziggurats + snowfall (near flakes defocused).
import { combat } from './e_scene.js'
import * as S from './e_style.js'
export default async function () {
  combat({
    bg: { skyTop: 0xaeb8c6, skyBottom: 0xeadcd0, haze: 0xe2dcd8, horizon: 490, grainK: 0.02, sun: { x: 300, y: 300, r: 30, k: 0.85, color: 0xfff1e2 }, layers: [
      { shape: 'zig', x: 1010, y: 70, slope: 0.95, top: 70, color: 0xc9ccd3, step: 7, soft: 2.8, fade: [70, 470, 0.0], jitter: 0.6 },
      { shape: 'zig', x: 880, y: 130, slope: 0.95, top: 50, color: 0xa8afbc, step: 7, soft: 1.6, fade: [130, 480, 0.03], jitter: 0.5 },
      { shape: 'mesa', x: 300, y: 250, slope: 0.7, top: 150, color: 0xb9bcc6, step: 5, soft: 2.2, fade: [250, 490, 0.02], jitter: 1.0 },
      { shape: 'zig', x: 700, y: 210, slope: 0.95, top: 30, color: 0x8b93a4, step: 6, soft: 1.0, fade: [210, 490, 0.05], jitter: 0.4 },
    ] },
    farDecor: (g) => { for (const [x, f] of [[372, 0.3], [390, 0.7]]) S.bird(g, x, 470, { s: 0.5, flap: f }) },
    terrain: { top: 0x8d97ab, mid: 0x4f5a70, deep: 0x141925, haze: 0xe2dcd8, rim: 0xf4f7fb, rimK: 0.95, yK: 0.8 },
    teamA: '#d8432a', teamB: '#139a93', tracer: '255,170,30', laser: '40,225,210', crystal: '255,170,90',
    smoke: { rgb: '60,62,76', a: 0.2, size: 6 }, plume: '24,26,34', eye: '#ffb030', gateAccent: '#9fd8ff', gateInner: 'rgba(236,232,230,0.95)',
    hud: { accent: '#d8432a', timer: '0:48' }, haloRGB: '226,222,228',
    overlay: g => S.snow(g, 320, 4),
  })
}
